/**
 * One engine declaration per shipped type-id, generated from today's per-engine tables, and the census that reads
 * each declaration back to every table it came from (docs/providers/CONTRACT.md, clauses M-9 and M-15).
 *
 * `scripts/generate-engine-declarations.ts` writes `src/lib/db/engine-declarations/<type-id>.json`, one
 * `#/$defs/engineDeclaration` of the provider manifest schema each. The census below does not call the generator: its
 * read-back functions are written here, from the tables, so a slip in the generator cannot certify itself. Each test
 * loops over every shipped id and fails with the list of ids whose declaration and table differ.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentCredentialForm,
  type BlockCommentRule,
  type BracketRule,
  compileManifestValidator,
  type CredentialWarning as ManifestCredentialWarning,
  type EngineDeclaration,
  type ExplainFormat as ManifestExplainFormat,
  type FieldName,
  type FieldPlacement as ManifestFieldPlacement,
  type FormatterLanguage,
  type GrammarFacts,
  type HashRule,
  type HostPathField as ManifestHostPathField,
  type HostUriScheme as ManifestHostUriScheme,
  type JwtAccessClaim,
  type MaintenanceOperation as ManifestMaintenanceOperation,
  type PlaceableFieldName,
  type ProcedureBodies,
  type QueryDialect as ManifestQueryDialect,
  type ScriptFacts,
  type ScriptUnit,
  type SelectFieldName,
  type StatementLanguage,
  type StatementRedaction,
} from "@libredb/provider-sdk/manifest";
import type {
  BlockCommentGrammar,
  BracketGrammar,
  HashGrammar,
  ProceduralBlockGrammar,
  ScriptGrammar,
  SqlGrammar,
} from "@libredb/provider-sdk/sql";
import {
  buildDialog,
  buildEditor,
  buildEngineDeclaration,
  buildFieldRules,
  buildSqlText,
  CAPABILITY_READ_ENVIRONMENT,
  declarationDirectoryProblems,
  EDITOR_TABLES,
  ENGINE_DECLARATIONS_DIRECTORY,
  readEngineCapabilities,
  refuseUndeclaredDialects,
  renderEngineDeclaration,
} from "../../../scripts/generate-engine-declarations";
import { refuseInexactJson } from "../../../scripts/read-engine-capabilities";
import { AGENT_STATEMENT_LANGUAGE, type AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import type { HostUriScheme } from "@/lib/connection-host-uri";
import { PASTE_FORMATS_TEXT } from "@/lib/connection-paste-formats";
import { detectConnectionStringType, parseConnectionString, pasteText } from "@/lib/connection-string-parser";
import {
  CONNECTION_FORM_URI_MODE,
  CONNECTION_STRING_ACCEPTED,
  EXTERNAL_DATABASE_TYPES,
  HOST_PATH_FIELDS,
  OPENS_LOCAL_FILE,
  OPENS_SERVER_LEVEL_WITHOUT_DATABASE,
  SHIPPED_DATABASE_TYPES,
  SSH_TUNNEL_REFUSAL,
} from "@/lib/db/compatibility";
import {
  CONNECTION_FIELD_DESCRIPTORS,
  CONNECTION_FIELDS,
  type ConnectionField,
  type FieldPlacement,
  PLACEABLE_FIELDS,
  type PlaceableField,
  REFUSED_CONNECTION_FIELDS,
  SEED_AGENT_CREDENTIAL,
  SEED_ONLY_FIELD_NAMES,
  SEED_ONLY_FIELDS,
  type SeedAgentCredential,
  type SeedOnlyField,
} from "@/lib/db/connection-fields";
import {
  CONNECTION_FORM,
  CONNECTION_PICKER_ORDER,
  type ConnectionFieldRule,
  type ConnectionFormSpec,
  connectionFieldRefusal,
  connectionFieldShown,
  offersSslPanel,
} from "@/lib/db/connection-form";
import {
  CONNECTION_STRING,
  CONNECTION_STRING_PASTE_ORDER,
  CONNECTION_STRING_PASTE_OVERLAPS,
  ENGINE_URI_SCHEMES,
} from "@/lib/db/connection-string";
import type { ConnectionStringPaste, ConnectionStringSpec } from "@/lib/db/connection-string/types";
import { CREDENTIAL_WARNINGS, type CredentialWarning } from "@/lib/db/credential-warnings";
import { ENGINE_FACETS } from "@/lib/db/engine-facets";
import { EXECUTION_UI, executionUiFor } from "@/lib/db/execution-ui";
import type { ConsentDeadline, ExecutionUiSpec } from "@/lib/db/execution-ui/types";
import { createDatabaseProvider } from "@/lib/db/factory";
import { MONITORING_PANELS } from "@/lib/db/engine-facets/types";
import { CURATED_OPERATION_KINDS } from "@/lib/db/operations/descriptors";
import { refusedFieldRefusal } from "@/lib/db/provider-connection";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import type { CompletionQuoting, SqlGrammarSpec, SqlRedaction, UpdateTargetGrammar } from "@/lib/db/sql-grammar/types";
import { MONGODB_SQL_GRAMMAR } from "@/lib/db/providers/document/mongodb/sql-grammar";
import { REDIS_SQL_GRAMMAR } from "@/lib/db/providers/keyvalue/redis-sql-grammar";
import { POSTGRES_SQL_GRAMMAR } from "@/lib/db/providers/sql/postgres-sql-grammar";
import { type DialectSpec, QUERY_DIALECTS, type QueryDialect } from "@/lib/db/query-dialects";
import { COUCHBASE_CONNECTION_STRING } from "@/lib/db/providers/document/couchbase/connection-string";
import { MONGODB_CONNECTION_STRING } from "@/lib/db/providers/document/mongodb/connection-string";
import { OPCUA_CONNECTION_STRING } from "@/lib/db/providers/industrial/opcua/connection-string";
import { ETCD_CONNECTION_STRING } from "@/lib/db/providers/keyvalue/etcd/connection-string";
import { REDIS_CONNECTION_STRING } from "@/lib/db/providers/keyvalue/redis-connection-string";
import { CLICKHOUSE_CONNECTION_STRING } from "@/lib/db/providers/sql/clickhouse/connection-string";
import { DATABEND_CONNECTION_STRING } from "@/lib/db/providers/sql/databend/connection-string";
import { DB2_CONNECTION_STRING } from "@/lib/db/providers/sql/db2/connection-string";
import { LIBSQL_CONNECTION_STRING } from "@/lib/db/providers/sql/libsql/connection-string";
import { MSSQL_CONNECTION_STRING } from "@/lib/db/providers/sql/mssql-connection-string";
import { MYSQL_CONNECTION_STRING } from "@/lib/db/providers/sql/mysql-connection-string";
import { ORACLE_CONNECTION_STRING } from "@/lib/db/providers/sql/oracle-connection-string";
import { POSTGRES_CONNECTION_STRING } from "@/lib/db/providers/sql/postgres-connection-string";
import {
  snowflakeAccountRefusal,
  snowflakeHostHint,
  snowflakeHostIdentity,
} from "@/lib/db/providers/sql/snowflake/account-host";
import { SNOWFLAKE_CONNECTION_STRING } from "@/lib/db/providers/sql/snowflake/connection-string";
import { SPARK_CONNECTION_STRING } from "@/lib/db/providers/sql/spark/connection-string";
import type { ExplainFormat, MaintenanceOperation, ProviderCapabilities } from "@/lib/db/types";
import { getExplainStrategy } from "@/lib/explain";
import { historyMaskOf } from "@/lib/history-mask";
import { importKubeconfig } from "@/lib/kubernetes/kubeconfig-import";
import { writesUnderGrammar } from "@/lib/sql/dangerous-query";
import { ALIAS_ENGINES, fenceTagEngine, isQueryFenceTag, QUERY_FENCE_ALIASES } from "@/lib/sql/fence-tags";
import { readOperativeKeyword } from "@/lib/sql/operative-keyword";
import { hasUnterminatedSpan, readSqlSpan } from "@/lib/sql/spans";
import { splitExecutionUnits } from "@/lib/sql/statement-splitter";
import { CONNECTION_FIELDS as FIELD_CLASSES } from "@/lib/storage/secret-fields";
import type { DatabaseConnection, DatabaseType, HostPathField } from "@/lib/types";
import { readCensusCapabilities } from "../../helpers/census-capabilities";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";
import { SPAN_STATEMENTS } from "./sql-grammar/fixtures";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SCRIPT = path.join(ROOT, "scripts/generate-engine-declarations.ts");
const DIRECTORY = path.join(ROOT, ENGINE_DECLARATIONS_DIRECTORY);
const SCHEMA_FILE = path.join(ROOT, "packages/provider-sdk/src/manifest/manifest.schema.json");
const SCHEMA = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as {
  $defs: Record<string, { enum?: unknown[]; properties?: Record<string, unknown>; required?: string[] }>;
};

/**
 * Each engine's capabilities as its provider declares them before it connects, read once through
 * `createDatabaseProvider` with the engine's census connection, the read the other provider censuses take, in a child
 * process with the generator's stated environment (tests/helpers/census-capabilities.ts); the generator reads them
 * through `readProviderDeclarations` instead, so the two reads share the connection record and the environment.
 */
const CAPABILITIES = await readCensusCapabilities();

/** A variable the Firestore provider reads when it is built, which turns its explain support off. */
const FIRESTORE_EMULATOR_VARIABLE = "FIRESTORE_EMULATOR_HOST";

/** The committed declaration of one type-id, parsed. */
function declared(type: DatabaseType): EngineDeclaration {
  return JSON.parse(readFileSync(path.join(DIRECTORY, `${type}.json`), "utf8")) as EngineDeclaration;
}

/** The shipped ids for which `matches` answers false: the census's failure list. */
function differing(matches: (type: DatabaseType, declaration: EngineDeclaration) => boolean): DatabaseType[] {
  return SHIPPED_DATABASE_TYPES.filter((type) => !matches(type, declared(type)));
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function sorted(values: readonly unknown[]): string[] {
  return values.map(String).sort();
}

/** A list of entries naming their field, read as a map from field to the member `pick` reads. */
function byField<Entry extends { readonly field: string }, Value>(
  entries: readonly Entry[],
  pick: (entry: Entry) => Value,
): Record<string, Value> {
  return Object.fromEntries(entries.map((entry) => [entry.field, pick(entry)]));
}

/** A partial record of the form as a plain map, an absent record as an empty one. */
function asMap<Value>(record: Partial<Record<string, Value>> | undefined): Record<string, Value> {
  return { ...(record ?? {}) } as Record<string, Value>;
}

/** Whether two values are deeply equal, compared through their JSON with object keys in one order. */
function sameValue(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Every member a redaction of any kind may hold. */
type RedactionMember = "kind" | "nameQuote" | "read";

/** The reader of a command redaction, or undefined where the redaction is of another kind. */
function commandReader(redaction: SqlRedaction): unknown {
  return redaction.kind === "command" ? redaction.read : undefined;
}

/**
 * The census's own resolver of the functions a declaration names: per engine, each name mapped to the function Studio
 * exports, imported here from its own module. It is written apart from the generator and the inventory, so a name is
 * held to the function the connection form runs by identity, and never by a function's `name`.
 *
 * A connection string name resolves to the slot of the engine's own connection string row, imported from its provider
 * module rather than from the registry index the generator reads: every URL TLS reader, paste reader and seed check is
 * private to its module, so the row's slot is the binding there is, and the census holds it to the slot core runs.
 * A SQL grammar name resolves the same way, to the slot of the engine's own grammar row imported from its provider
 * module: every redaction reader and completion reader is private to its module too.
 */
const NAMED_FUNCTIONS: Readonly<Partial<Record<DatabaseType, Readonly<Record<string, unknown>>>>> = {
  snowflake: {
    hostCheck: snowflakeAccountRefusal,
    hostHint: snowflakeHostHint,
    hostIdentity: snowflakeHostIdentity,
    pasteReader: SNOWFLAKE_CONNECTION_STRING.paste,
    seedCheck: SNOWFLAKE_CONNECTION_STRING.validateSeed,
  },
  kubernetes: { importer: importKubeconfig },
  clickhouse: { pasteReader: CLICKHOUSE_CONNECTION_STRING.paste },
  couchbase: { pasteReader: COUCHBASE_CONNECTION_STRING.paste },
  databend: { pasteReader: DATABEND_CONNECTION_STRING.paste },
  db2: { urlTls: DB2_CONNECTION_STRING.readTls, pasteReader: DB2_CONNECTION_STRING.paste },
  etcd: { seedCheck: ETCD_CONNECTION_STRING.validateSeed },
  libsql: { pasteReader: LIBSQL_CONNECTION_STRING.paste },
  mongodb: {
    pasteReader: MONGODB_CONNECTION_STRING.paste,
    redactionReader: commandReader(MONGODB_SQL_GRAMMAR.redaction),
  },
  mssql: { urlTls: MSSQL_CONNECTION_STRING.readTls, pasteReader: MSSQL_CONNECTION_STRING.paste },
  mysql: { urlTls: MYSQL_CONNECTION_STRING.readTls, pasteReader: MYSQL_CONNECTION_STRING.paste },
  opcua: { seedCheck: OPCUA_CONNECTION_STRING.validateSeed },
  oracle: { pasteReader: ORACLE_CONNECTION_STRING.paste },
  postgres: {
    urlTls: POSTGRES_CONNECTION_STRING.readTls,
    pasteReader: POSTGRES_CONNECTION_STRING.paste,
    formatSegment: POSTGRES_SQL_GRAMMAR.completion.formatSegment,
    readQuotedQualifier: POSTGRES_SQL_GRAMMAR.completion.readQuotedQualifier,
  },
  redis: { pasteReader: REDIS_CONNECTION_STRING.paste, redactionReader: commandReader(REDIS_SQL_GRAMMAR.redaction) },
  spark: { pasteReader: SPARK_CONNECTION_STRING.paste },
};

/** The function `name` resolves to for `type` through the census's resolver, or undefined where it names none. */
function resolveNamed(type: DatabaseType, name: string): unknown {
  const table = NAMED_FUNCTIONS[type];
  return table !== undefined && Object.hasOwn(table, name) ? table[name] : undefined;
}

/** Every function-shaped value under `value`, by its dotted path, a RegExp and an object already seen left unread. */
function functionPaths(value: unknown, at: string, seen = new Set<unknown>()): string[] {
  if (typeof value === "function") return [at];
  if (typeof value !== "object" || value === null || value instanceof RegExp || seen.has(value)) return [];
  seen.add(value);
  return Object.keys(value).flatMap((key) =>
    functionPaths((value as Record<string, unknown>)[key], at === "" ? key : `${at}.${key}`, seen),
  );
}

/** The slots of a connection form entry whose function the declaration names, as `functionPaths` spells them. */
function namedSlotPaths(d: EngineDeclaration): string[] {
  const { connection } = d;
  return [
    ...connection.fieldRules.filter((rule) => rule.check !== null).map((rule) => `fieldRules.${rule.field}.check`),
    ...(connection.hostHint === null ? [] : ["hostHint"]),
    ...(connection.hostIdentity === null ? [] : ["hostIdentity"]),
    ...(connection.import === null ? [] : ["connectionImport.load"]),
  ];
}

/** The slots of a connection string row whose function the declaration names, as `functionPaths` spells them. */
function connectionStringSlotPaths(d: EngineDeclaration): string[] {
  const { urlTls, paste, seedCheck } = d.connection.connectionString;
  return [
    ...(urlTls === null ? [] : ["readTls"]),
    ...(paste === null ? [] : ["paste.claims", "paste.names", "paste.parse"]),
    ...(seedCheck === null ? [] : ["validateSeed"]),
  ];
}

/** The connection string function names a declaration states. */
function connectionStringNames(d: EngineDeclaration): string[] {
  const { urlTls, paste, seedCheck } = d.connection.connectionString;
  return [
    ...(urlTls === null ? [] : [urlTls]),
    ...(paste === null ? [] : [paste.reader]),
    ...(seedCheck === null ? [] : [seedCheck]),
  ];
}

/** The slots of a SQL grammar row whose function the declaration names, as `functionPaths` spells them. */
function sqlTextSlotPaths(d: EngineDeclaration): string[] {
  const { redaction, completion } = d.sqlText;
  return [
    ...(redaction.kind === "command" ? ["redaction.read"] : []),
    ...(completion.formatSegment === null ? [] : ["completion.formatSegment"]),
    ...(completion.readQuotedQualifier === null ? [] : ["completion.readQuotedQualifier"]),
  ];
}

/** The SQL grammar function names a declaration states. */
function sqlTextNames(d: EngineDeclaration): string[] {
  const { redaction, completion } = d.sqlText;
  return [
    ...(redaction.kind === "command" ? [redaction.reader] : []),
    ...(completion.formatSegment === null ? [] : [completion.formatSegment]),
    ...(completion.readQuotedQualifier === null ? [] : [completion.readQuotedQualifier]),
  ];
}

/**
 * The grammar facts a declaration states for `grammar`, written here from the readers and the SDK's SqlGrammar doc
 * comments rather than from the generator: a fact the grammar leaves out at the reading its readers give that absence
 * (false for a form a reader tests with `=== true` or truthiness, true for `dollarTags`, which a reader tests with
 * `=== false`, an empty list where a reader reads `?? []`, `postgresql` for the formatter, two empty word lists for
 * completion), the two backslash overrides and the session keys null where they are left out, since each has a reading
 * no value of its type gives, and each trailing limit clause by its source and flags.
 */
function declaredGrammar(grammar: SqlGrammar): GrammarFacts {
  return {
    hash: grammar.hash,
    bracket: grammar.bracket,
    blockComment: grammar.blockComment,
    alternateQuoting: grammar.alternateQuoting,
    doubleSlashComment: grammar.doubleSlashComment,
    backslashAlwaysEscapes: grammar.backslashAlwaysEscapes,
    tripleQuotedStrings: grammar.tripleQuotedStrings === true,
    backtickBackslashEscapes: grammar.backtickBackslashEscapes === true,
    dollarTags: grammar.dollarTags !== false,
    doubleQuoteBackslashEscapes: grammar.doubleQuoteBackslashEscapes ?? null,
    singleQuoteBackslashEscapes: grammar.singleQuoteBackslashEscapes ?? null,
    rawStrings: grammar.rawStrings === true,
    hintsAreCode: grammar.hintsAreCode === true,
    lineCommentBackslashContinues: grammar.lineCommentBackslashContinues === true,
    lineCommentEndsAtCarriageReturn: grammar.lineCommentEndsAtCarriageReturn === true,
    script: {
      blocks: grammar.script.blocks,
      separatorLine: grammar.script.separatorLine,
      unit: grammar.script.unit,
      terminatedStatements: [...(grammar.script.terminatedStatements ?? [])],
    },
    trailingLimitClauses: grammar.trailingLimitClauses.map((pattern) => ({
      source: pattern.source,
      flags: pattern.flags as "i" | "iu",
    })),
    nonNumericRowBounds: [...(grammar.nonNumericRowBounds ?? [])],
    confirmForms: (grammar.confirmForms ?? []).map((form) => form.slice()),
    confirmCodeForms: (grammar.confirmCodeForms ?? []).map((form) => (Array.isArray(form) ? form.slice() : form)),
    confirmFormsWhen: (grammar.confirmFormsWhen ?? []).map(({ form, when }) => ({ form: form.slice(), when })),
    confirmExemptForms: (grammar.confirmExemptForms ?? []).map((form) => form.slice()),
    formatterLanguage: grammar.formatterLanguage ?? "postgresql",
    completionWords: {
      keywords: [...(grammar.completionWords?.keywords ?? [])],
      functions: [...(grammar.completionWords?.functions ?? [])],
    },
    confirmConfigKeys: grammar.confirmConfigKeys === undefined ? null : [...grammar.confirmConfigKeys],
    explainExecutesWithAnalyze: grammar.explainExecutesWithAnalyze === true,
  };
}

/**
 * A grammar read from a declaration, as a host that admits it would build one: each trailing limit clause compiled from
 * its source and flags, and each fact stated as null, and the formatter language stated as `postgresql`, left out, so
 * its readers take the reading of its absence.
 */
function grammarFromDeclaration(d: EngineDeclaration): SqlGrammar {
  const {
    doubleQuoteBackslashEscapes,
    singleQuoteBackslashEscapes,
    confirmConfigKeys,
    formatterLanguage,
    trailingLimitClauses,
    ...facts
  } = d.sqlText.grammar;
  return {
    ...facts,
    trailingLimitClauses: trailingLimitClauses.map(({ source, flags }) => new RegExp(source, flags)),
    ...(doubleQuoteBackslashEscapes === null ? {} : { doubleQuoteBackslashEscapes }),
    ...(singleQuoteBackslashEscapes === null ? {} : { singleQuoteBackslashEscapes }),
    ...(confirmConfigKeys === null ? {} : { confirmConfigKeys }),
    ...(formatterLanguage === "postgresql" ? {} : { formatterLanguage }),
  };
}

/** A statement naming a confirmation code form, written out. */
function codeFormStatement(form: NonNullable<SqlGrammar["confirmCodeForms"]>[number]): string {
  if (Array.isArray(form)) return `SELECT ${form.join(" ")}`;
  if ("prefix" in form) return `SELECT ${form.prefix}X(1)`;
  if ("wordThenLiteral" in form) return `SELECT TRANSFORM (a) ${form.wordThenLiteral} 'cat' FROM t`;
  if ("wordThenBody" in form) return `${form.wordThenBody} $$ SELECT 1 $$`;
  if ("quotedCall" in form) return `SELECT \`${form.quotedCall}\`('a'), "${form.quotedCall}"('a')`;
  if ("computedCall" in form) return `SELECT ${form.computedCall}('f')(1)`;
  return "SELECT $t$x$t$, $$y$$";
}

/**
 * The statements the behavioural read-back runs under both grammars: the golden span statements, one statement naming
 * each fact whose absent reading a declaration writes, and every form a shipped grammar declares, written out.
 */
function censusCorpus(): string[] {
  const forms = SHIPPED_DATABASE_TYPES.flatMap((type) => {
    const { grammar } = SQL_GRAMMAR[type];
    return [
      ...(grammar.confirmForms ?? []).map((form) => form.join(" ")),
      ...(grammar.confirmExemptForms ?? []).map((form) => `${form.join(" ")} x = 1`),
      ...(grammar.confirmFormsWhen ?? []).map(({ form, when }) => `${form.join(" ")} s ${when} = 'x'`),
      ...(grammar.confirmCodeForms ?? []).map(codeFormStatement),
      ...(grammar.confirmConfigKeys ?? []).map((key) => `SET ${key}x = 1`),
    ];
  });
  return [
    ...SPAN_STATEMENTS,
    "SELECT $t$x; DELETE FROM t; $t$",
    "SELECT 'a\\' FROM \".x\" --'",
    'SELECT "a\\"; DELETE FROM t --"',
    "SELECT `a\\` WHERE x = '`; DELETE FROM t --'",
    "SELECT r'C:\\'; DROP TABLE t; --'",
    "SELECT '''a'b'''; DELETE FROM t; --'",
    "/* a /*+ b */ DELETE FROM t; -- */",
    "WITH c AS (SELECT 1 -- note \\\n) SELECT 1 --\n) DELETE FROM u",
    "WITH c AS (SELECT 1) -- note\rINSERT INTO u\nSELECT 1",
    "RESET",
    "RESET spark.sql.defaultCatalog",
    "SET spark.sql.defaultCatalog = x",
    "EXPLAIN ANALYZE DELETE FROM t",
    "ALTER SESSION SET x = 1",
    "MERGE INTO t USING s ON t.a = s.a WHEN MATCHED THEN DELETE; SELECT 1",
    ...forms,
  ];
}

/** The span walk from 0: a span is `[kind, start, end]`, and where none starts the walk steps one character. */
function spanWalk(sql: string, grammar: SqlGrammar): [string, number, number][] {
  const spans: [string, number, number][] = [];
  let index = 0;
  while (index < sql.length) {
    const span = readSqlSpan(sql, index, grammar);
    if (span === null) {
      index += 1;
      continue;
    }
    spans.push([span.kind, index, span.end]);
    index = span.end;
  }
  return spans;
}

/** What Studio's SQL readers answer of `sql` under `grammar`, one reading per reader. */
function readings(sql: string, grammar: SqlGrammar): unknown {
  return {
    spans: spanWalk(sql, grammar),
    units: splitExecutionUnits(sql, grammar),
    operative: readOperativeKeyword(sql, grammar),
    unterminated: hasUnterminatedSpan(sql, grammar),
    writes: writesUnderGrammar(sql, grammar),
  };
}

/** The schema's generic fence tags: the tags of a language several engines speak, which name no engine. */
const GENERIC_FENCE_TAGS: readonly string[] = (SCHEMA.$defs.genericFenceTag?.enum ?? []).map(String);

/**
 * The dialect table the declarations state, built here from them: each dialect's row read from the first declaration
 * that names it, its tab named by the dialect, `offersSqlExport` as written and a null history mask as none. A second
 * declaration of one dialect must state the same row, or the table is refused by name.
 */
function derivedDialects(): Readonly<Record<QueryDialect, DialectSpec>> {
  const table: Partial<Record<QueryDialect, DialectSpec>> = {};
  for (const type of SHIPPED_DATABASE_TYPES) {
    const row = declared(type).editor.dialect;
    if (row === null) continue;
    const spec: DialectSpec = {
      tabType: row.name,
      offersColumnProfiling: row.offersColumnProfiling,
      offersCodeGeneration: row.offersCodeGeneration,
      offersCountQuery: row.offersCountQuery,
      offersSqlExport: row.offersSqlExport,
      ...(row.historyMask === null ? {} : { historyMask: { credentialFlags: [...row.historyMask.credentialFlags] } }),
    };
    const earlier = table[row.name];
    if (earlier !== undefined && !sameValue(earlier, spec)) {
      throw new Error(`${type}: the ${row.name} dialect's row differs from an earlier declaration's`);
    }
    table[row.name] = spec;
  }
  return table as Record<QueryDialect, DialectSpec>;
}

describe("the committed declarations", () => {
  test("the directory holds exactly one declaration per shipped type-id", () => {
    expect(declarationDirectoryProblems(readdirSync(DIRECTORY), SHIPPED_DATABASE_TYPES)).toEqual([]);
    expect(readdirSync(DIRECTORY).length).toBe(SHIPPED_DATABASE_TYPES.length);
  });

  test("a stray file and a missing one each fail by name", () => {
    const entries = [...SHIPPED_DATABASE_TYPES.filter((type) => type !== "redis").map((type) => `${type}.json`)];

    expect(declarationDirectoryProblems([...entries, "acmedb.json", "notes.txt"], SHIPPED_DATABASE_TYPES)).toEqual([
      "redis.json is missing",
      "acmedb.json declares no shipped type-id",
      "notes.txt is not a declaration",
    ]);
  });

  test("each declaration is what the generator builds from the tables", async () => {
    const capabilities = await readEngineCapabilities();
    const stale = SHIPPED_DATABASE_TYPES.filter(
      (type) =>
        readFileSync(path.join(DIRECTORY, `${type}.json`), "utf8") !==
        renderEngineDeclaration(buildEngineDeclaration(type, capabilities[type])),
    ).map((type) => `${ENGINE_DECLARATIONS_DIRECTORY}/${type}.json differs: run bun run engines:generate`);

    expect(stale).toEqual([]);
  });

  test("each declaration is admitted by the schema's engine declaration and its rules", () => {
    const validator = compileManifestValidator(readFileSync(SCHEMA_FILE));
    const refused = SHIPPED_DATABASE_TYPES.filter((type) => !validator.validateEngine(declared(type)).admitted);

    expect(refused).toEqual([]);
  });

  test("the generator refuses, by name, a field rule for a field the engine does not list", () => {
    const form: ConnectionFormSpec = {
      ...CONNECTION_FORM.postgres,
      fieldRules: { warehouse: { required: crypto.randomUUID() } },
    };

    expect(() => buildFieldRules(form, CONNECTION_FIELDS.postgres, "postgres")).toThrow(
      'postgres: the fieldRules entry for "warehouse" names a field the engine does not list',
    );
  });

  test("the generator refuses, by name, a dialog entry for a field the engine does not list", () => {
    const entries: Partial<ConnectionFormSpec>[] = [
      { fieldLabels: { warehouse: "Warehouse" } },
      { fieldHints: { warehouse: "The warehouse a session uses." } },
      { fieldPlaceholders: { warehouse: "COMPUTE_WH" } },
      { fieldOptions: { warehouse: [{ value: "small", label: "Small" }] } },
      { fieldShownWhen: { warehouse: { field: "host", equals: "localhost" } } },
      { fieldDefaults: { warehouse: "COMPUTE_WH" } },
    ];

    for (const entry of entries) {
      const form: ConnectionFormSpec = { ...CONNECTION_FORM.postgres, ...entry };
      const [record] = Object.keys(entry);
      expect(() => buildDialog(form, CONNECTION_FIELDS.postgres, "postgres")).toThrow(
        `postgres: the ${record} entry for "warehouse" names a field the engine does not list`,
      );
    }
  });

  test("the generator refuses, by name, an explain format the provider's explain support contradicts", () => {
    const unformatted: ProviderCapabilities = { ...CAPABILITIES.postgres, explainFormat: undefined };
    const unsupported: ProviderCapabilities = {
      ...CAPABILITIES.kafka,
      supportsExplain: false,
      explainFormat: "postgres-json",
    };

    expect(() => buildEditor("postgres", unformatted)).toThrow(
      "postgres: the provider supports explain but declares no explain format",
    );
    expect(() => buildEditor("kafka", unsupported)).toThrow(
      "kafka: the provider declares an explain format but supports no explain",
    );
  });

  test("the generator refuses, by name, a dialect QUERY_DIALECTS has no row for", () => {
    const dialects = Object.fromEntries(Object.entries(QUERY_DIALECTS).filter(([dialect]) => dialect !== "kafka"));

    expect(() => buildEditor("kafka", CAPABILITIES.kafka, { ...EDITOR_TABLES, dialects })).toThrow(
      "kafka: the provider declares the kafka dialect, which QUERY_DIALECTS has no row for",
    );
  });

  test("the generator refuses, by name, a dialect row whose tab type is not its name", () => {
    const dialects = { ...QUERY_DIALECTS, kafka: { ...QUERY_DIALECTS.kafka, tabType: "redis" as const } };

    expect(() => buildEditor("kafka", CAPABILITIES.kafka, { ...EDITOR_TABLES, dialects })).toThrow(
      "kafka: the kafka dialect's tab type \"redis\" is not the dialect's name",
    );
  });

  test("the generator refuses, by name, a dialect row no engine declares", () => {
    const capabilities = { ...CAPABILITIES, kafka: { ...CAPABILITIES.kafka, queryDialect: undefined } };

    expect(() => refuseUndeclaredDialects(CAPABILITIES)).not.toThrow();
    expect(() => refuseUndeclaredDialects(capabilities)).toThrow(
      "the kafka dialect's row in QUERY_DIALECTS is declared by no engine",
    );
  });

  test("the generator refuses, by name, a fence alias that is no query fence tag", () => {
    const alias = `q${crypto.randomUUID().replaceAll("-", "")}`;
    const aliasEngines = { ...ALIAS_ENGINES, [alias]: "kafka" as const };

    expect(() => buildEditor("kafka", CAPABILITIES.kafka, { ...EDITOR_TABLES, aliasEngines })).toThrow(
      `kafka: the fence alias "${alias}" names the engine but is not a query fence tag`,
    );
  });

  test("the generator refuses, by name, a SQL grammar member it has no place for", () => {
    const key = `k${crypto.randomUUID().replaceAll("-", "")}`;
    const row = SQL_GRAMMAR.kafka;
    const planted: [SqlGrammarSpec, string][] = [
      [{ ...row, grammar: { ...row.grammar, [key]: true } }, `grammar.${key}`],
      [
        { ...row, grammar: { ...row.grammar, script: { ...row.grammar.script, [key]: true } } },
        `grammar.script.${key}`,
      ],
      [{ ...row, [key]: true }, key],
      [{ ...row, redaction: { ...row.redaction, [key]: true } }, `redaction.${key}`],
      [{ ...row, updateTarget: { ...row.updateTarget, [key]: true } }, `updateTarget.${key}`],
      [{ ...row, completion: { ...row.completion, [key]: null } }, `completion.${key}`],
      [
        { ...row, grammar: { ...row.grammar, completionWords: { keywords: [], functions: [], [key]: true } } },
        `grammar.completionWords.${key}`,
      ],
      [
        { ...row, grammar: { ...row.grammar, confirmFormsWhen: [{ form: ["REPLACE"], when: "ON", [key]: true }] } },
        `grammar.confirmFormsWhen.0.${key}`,
      ],
    ];

    expect(() => buildSqlText("kafka", row)).not.toThrow();
    for (const [spec, member] of planted) {
      expect(() => buildSqlText("kafka", spec)).toThrow(
        `kafka: the SQL grammar member "${member}" has no place in the engine declaration`,
      );
    }
  });

  test("the generator refuses, by name, a trailing limit clause whose flags the contract does not allow", () => {
    const row = SQL_GRAMMAR.cassandra;
    const clauses = (flags: string) => [...row.grammar.trailingLimitClauses, new RegExp("\\s+X\\s*$", flags)];
    const index = row.grammar.trailingLimitClauses.length;

    for (const flags of ["g", "", "im", "iy"]) {
      const spec: SqlGrammarSpec = { ...row, grammar: { ...row.grammar, trailingLimitClauses: clauses(flags) } };

      expect(() => buildSqlText("cassandra", spec)).toThrow(
        `cassandra: trailing limit clause ${index} has flags "${flags}"; the provider contract allows i or iu`,
      );
    }
    const unicode: SqlGrammarSpec = { ...row, grammar: { ...row.grammar, trailingLimitClauses: clauses("iu") } };

    expect(buildSqlText("cassandra", unicode).grammar.trailingLimitClauses[index]).toEqual({
      source: "\\s+X\\s*$",
      flags: "iu",
    });
  });

  test("--check names a differing, missing or extra file, and --write writes every declaration and removes a stray one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "engine-declarations-"));
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    try {
      expect(run("--check").exitCode).toBe(0);

      const out = path.join(dir, "declarations");
      mkdirSync(out);
      writeFileSync(path.join(out, "retireddb.json"), "{}\n");
      expect(run("--write", "--out", out).exitCode).toBe(0);
      expect(readdirSync(out).sort()).toEqual(SHIPPED_DATABASE_TYPES.map((type) => `${type}.json`).sort());
      for (const type of SHIPPED_DATABASE_TYPES) {
        expect(readFileSync(path.join(out, `${type}.json`), "utf8")).toBe(
          readFileSync(path.join(DIRECTORY, `${type}.json`), "utf8"),
        );
      }
      expect(run("--check", "--out", out).exitCode).toBe(0);

      writeFileSync(path.join(out, "postgres.json"), "{}\n");
      rmSync(path.join(out, "mysql.json"));
      writeFileSync(path.join(out, "acmedb.json"), "{}\n");
      const stale = run("--check", "--out", out);
      expect(stale.exitCode).toBe(1);
      const report = stale.stderr.toString();
      expect(report).toContain("postgres.json differs");
      expect(report).toContain("mysql.json is missing");
      expect(report).toContain("acmedb.json declares no shipped type-id");
      expect(report).toContain("bun run engines:generate");

      writeFileSync(path.join(out, "notes.txt"), "kept\n");
      const foreign = run("--write", "--out", out);
      expect(foreign.exitCode).toBe(1);
      expect(foreign.stderr.toString()).toContain("notes.txt is not a declaration");

      for (const args of [[], ["--check", "--write"], ["--write", "--out"], ["--check", "--verbose"]]) {
        const refused = run(...args);
        expect(refused.exitCode).toBe(2);
        expect(refused.stderr.toString()).toContain("Usage:");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Four of the runs build every provider to read its capabilities, about 2 s with coverage on; ten times that.
  }, 20000);

  test("a variable a provider reads before it connects, set where the generator runs, changes no declaration", () => {
    const planted = Bun.spawnSync([process.execPath, SCRIPT, "--check"], {
      cwd: ROOT,
      env: { ...process.env, [FIRESTORE_EMULATOR_VARIABLE]: "127.0.0.1:1" },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(planted.stderr.toString()).toBe("");
    expect(planted.exitCode).toBe(0);
    // One run builds every provider to read its capabilities, about 2 s with coverage on; ten times that.
  }, 20000);

  test("the capability read runs in the environment it is given, and a child that fails rejects it with its exit code", async () => {
    expect(CAPABILITY_READ_ENVIRONMENT).toEqual({});
    // Vacuity: a variable handed to the read reaches the providers it builds, so the stated environment is the one read.
    await expect(readEngineCapabilities({ LIBREDB_ENABLED_PROVIDERS: "postgres" })).rejects.toThrow(
      "the capability read (scripts/read-engine-capabilities.ts) exited with code 1",
    );
  });

  test("the capability read refuses, by name, a capability JSON cannot carry exactly", () => {
    const undefinedMember: ProviderCapabilities = { ...CAPABILITIES.postgres, explainFormat: undefined };
    const functionMember = {
      ...CAPABILITIES.postgres,
      createTable: () => undefined,
    } as unknown as ProviderCapabilities;

    expect(() => refuseInexactJson("postgres", CAPABILITIES.postgres)).not.toThrow();
    for (const capabilities of [undefinedMember, functionMember]) {
      expect(() => refuseInexactJson("postgres", capabilities)).toThrow(
        "postgres: the provider's capabilities hold a value JSON cannot carry exactly",
      );
    }
  });
});

describe("the census", () => {
  test("displayName is the connection form's label", () => {
    expect(differing((type, d) => d.displayName === CONNECTION_FORM[type].label)).toEqual([]);
  });

  test("location is external exactly for the external engines", () => {
    expect(differing((type, d) => (d.location === "external") === EXTERNAL_DATABASE_TYPES.includes(type))).toEqual([]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => declared(type).location === "embedded")).toEqual(["libredb"]);
  });

  test("connection.fields is the engine's CONNECTION_FIELDS row, in order", () => {
    expect(differing((type, d) => sameList(d.connection.fields, CONNECTION_FIELDS[type]))).toEqual([]);
  });

  test("connection.defaults reads back as the form's default port and host", () => {
    const portText = (d: EngineDeclaration) =>
      d.connection.defaults.port === undefined ? "" : String(d.connection.defaults.port);

    expect(differing((type, d) => portText(d) === CONNECTION_FORM[type].defaultPort)).toEqual([]);
    expect(differing((type, d) => d.connection.defaults.host === CONNECTION_FORM[type].defaultHost)).toEqual([]);
  });

  test("connection.seedOnly renders every refusal the table's functions give", () => {
    const samples: readonly [string, string][] = [
      ["seed-one", "opensearch"],
      ["warehouse_2", "postgres"],
    ];
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const row = SEED_ONLY_FIELDS[type];
      const seedOnly = d.connection.seedOnly;
      if (row === null || seedOnly === null) return row === seedOnly;
      const projection = seedOnly.projectionRefusal;
      const projectionMatches =
        row.projectionRefusal === null
          ? projection === null
          : projection !== null &&
            samples.every(
              ([id, other]) =>
                projection.replaceAll("{id}", id).replaceAll("{type}", other) === row.projectionRefusal?.(id, other),
            );
      return (
        sameList(seedOnly.fields, row.fields) &&
        seedOnly.scope === row.kind &&
        row.fields.every((field) => seedOnly.refusal.replaceAll("{field}", field) === row.refusal(field)) &&
        projectionMatches
      );
    };

    expect(differing(matches)).toEqual([]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => declared(type).connection.seedOnly !== null).length).toBe(4);
  });

  test("connection.refused is the engine's REFUSED_CONNECTION_FIELDS row, each field with its sentence, in the order core checks them", () => {
    const entries = (d: EngineDeclaration) => d.connection.refused.map(({ field, refusal }) => [field, refusal]);

    expect(differing((type, d) => sameValue(entries(d), Object.entries(REFUSED_CONNECTION_FIELDS[type])))).toEqual([]);
    expect(
      SHIPPED_DATABASE_TYPES.filter((type) => declared(type).connection.refused.length > 0).length,
    ).toBeGreaterThan(0);
  });

  test("core refuses a connection that sets a refused field with the sentence its declaration states", () => {
    const connection = (type: DatabaseType, fields: readonly string[]): DatabaseConnection =>
      ({
        id: `census-${type}`,
        name: `census-${type}`,
        type,
        ...Object.fromEntries(fields.map((field) => [field, crypto.randomUUID()])),
      }) as DatabaseConnection;
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const { refused } = d.connection;
      const fields = refused.map((entry) => entry.field);
      return (
        refused.every(
          ({ field, refusal }) =>
            typeof refusal === "string" && refusedFieldRefusal(connection(type, [field])) === refusal,
        ) &&
        refusedFieldRefusal(connection(type, fields)) === refused[0]?.refusal &&
        refusedFieldRefusal(connection(type, [])) === undefined
      );
    };

    expect(differing(matches)).toEqual([]);
  });

  test("connection.hostPathFields is the engine's HOST_PATH_FIELDS row", () => {
    expect(differing((type, d) => sameList(d.connection.hostPathFields, HOST_PATH_FIELDS[type]))).toEqual([]);
  });

  test("connection.agentCredential is the engine's SEED_AGENT_CREDENTIAL row", () => {
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const row = SEED_AGENT_CREDENTIAL[type];
      const credential = d.connection.agentCredential;
      if (row === null || credential === null) return row === credential;
      return credential.form === row.form && sameList(credential.supersededBy, row.supersededBy);
    };

    expect(differing(matches)).toEqual([]);
  });

  test("connection.connectionString is what the provider accepts and what the dialog offers", () => {
    expect(differing((type, d) => d.connection.connectionString.accepted === CONNECTION_STRING_ACCEPTED[type])).toEqual(
      [],
    );
    expect(
      differing((type, d) => d.connection.connectionString.dialogOffersUri === CONNECTION_FORM_URI_MODE[type]),
    ).toEqual([]);
  });

  test("connection.sshTunnel is offered exactly where no SSH_TUNNEL_REFUSAL sentence is, and carries that sentence", () => {
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const sentence = SSH_TUNNEL_REFUSAL[type];
      const tunnel = d.connection.sshTunnel;
      return tunnel.offered ? sentence === null : tunnel.refusal === sentence;
    };

    expect(differing(matches)).toEqual([]);
  });

  test("connection.tls is offered exactly where the dialog offers the SSL panel", () => {
    expect(differing((type, d) => (d.connection.tls === "offered") === offersSslPanel(type))).toEqual([]);
  });

  test("connection.opensLocalFile and serverLevelWithoutDatabase are their records", () => {
    expect(differing((type, d) => d.connection.opensLocalFile === OPENS_LOCAL_FILE[type])).toEqual([]);
    expect(
      differing((type, d) => d.connection.serverLevelWithoutDatabase === OPENS_SERVER_LEVEL_WITHOUT_DATABASE[type]),
    ).toEqual([]);
  });

  test("facets are the engine's ENGINE_FACETS row", () => {
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const row = ENGINE_FACETS[type];
      return (
        MONITORING_PANELS.every((panel) => d.facets.monitoring[panel] === row.monitoring[panel]) &&
        Object.keys(d.facets.monitoring).length === MONITORING_PANELS.length &&
        sameList(d.facets.maintenance, row.maintenance) &&
        sameList(d.facets.agentReadings, row.agentReadings)
      );
    };

    expect(differing(matches)).toEqual([]);
  });

  test("agent.statementLanguage is the engine's AGENT_STATEMENT_LANGUAGE row", () => {
    expect(differing((type, d) => d.agent.statementLanguage === AGENT_STATEMENT_LANGUAGE[type])).toEqual([]);
  });

  test("connection.dialog.order is the form's dialogOrder", () => {
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const order = CONNECTION_FORM[type].dialogOrder;
      const declaredOrder = d.connection.dialog.order;
      return order === undefined ? declaredOrder === null : declaredOrder !== null && sameList(declaredOrder, order);
    };

    expect(differing(matches)).toEqual([]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => declared(type).connection.dialog.order !== null)).toEqual([
      "bigquery",
    ]);
  });

  test("connection.dialog.labels, hints and placeholders are the form's", () => {
    const text = (entry: { readonly text: string }) => entry.text;

    expect(
      differing((type, d) =>
        sameValue(byField(d.connection.dialog.labels, text), asMap(CONNECTION_FORM[type].fieldLabels)),
      ),
    ).toEqual([]);
    expect(
      differing((type, d) =>
        sameValue(byField(d.connection.dialog.hints, text), asMap(CONNECTION_FORM[type].fieldHints)),
      ),
    ).toEqual([]);
    expect(
      differing((type, d) =>
        sameValue(byField(d.connection.dialog.placeholders, text), asMap(CONNECTION_FORM[type].fieldPlaceholders)),
      ),
    ).toEqual([]);
    const emptyPlaceholders = SHIPPED_DATABASE_TYPES.flatMap((type) =>
      declared(type)
        .connection.dialog.placeholders.filter((entry) => entry.text === "")
        .map((entry) => `${type}.${entry.field}`),
    );
    expect(emptyPlaceholders.length).toBeGreaterThan(0);
  });

  test("connection.dialog.placement is the form's fieldPlacement", () => {
    expect(
      differing((type, d) =>
        sameValue(
          byField(d.connection.dialog.placement, (entry) => entry.where),
          asMap(CONNECTION_FORM[type].fieldPlacement),
        ),
      ),
    ).toEqual([]);
  });

  test("connection.dialog.options are the form's fieldOptions, choices in order", () => {
    const choices = (entry: { readonly choices: readonly { readonly value: string; readonly label: string }[] }) =>
      entry.choices.map(({ value, label }) => ({ value, label }));

    expect(
      differing((type, d) =>
        sameValue(byField(d.connection.dialog.options, choices), asMap(CONNECTION_FORM[type].fieldOptions)),
      ),
    ).toEqual([]);
  });

  test("connection.dialog.shownWhen and absentValues are the form's fieldShownWhen and fieldDefaults", () => {
    expect(
      differing((type, d) =>
        sameValue(
          byField(d.connection.dialog.shownWhen, ({ when }) => ({ field: when.field, equals: when.equals })),
          asMap(CONNECTION_FORM[type].fieldShownWhen),
        ),
      ),
    ).toEqual([]);
    expect(
      differing((type, d) =>
        sameValue(
          byField(d.connection.dialog.absentValues, (entry) => entry.value),
          asMap(CONNECTION_FORM[type].fieldDefaults),
        ),
      ),
    ).toEqual([]);
  });

  test("a form read from the declaration shows the same fields as the connection form for every value of each controlling field", () => {
    const outside = `outside-${crypto.randomUUID()}`;
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const form = CONNECTION_FORM[type];
      const fromDeclaration: ConnectionFormSpec = {
        label: form.label,
        defaultPort: form.defaultPort,
        showConnectionStringToggle: form.showConnectionStringToggle,
        connectionFields: d.connection.fields as readonly ConnectionField[],
        fieldShownWhen: byField(d.connection.dialog.shownWhen, ({ when }) => ({
          field: when.field as ConnectionField,
          equals: when.equals,
        })),
        fieldDefaults: byField(d.connection.dialog.absentValues, (entry) => entry.value),
      };
      const controllers = new Set<ConnectionField>([
        ...Object.values(form.fieldShownWhen ?? {}).map((condition) => condition.field),
        ...d.connection.dialog.shownWhen.map(({ when }) => when.field as ConnectionField),
      ]);
      return [...controllers].every((controller) => {
        const values: unknown[] = [
          ...(form.fieldOptions?.[controller] ?? []).map((choice) => choice.value),
          undefined,
          null,
          "",
          outside,
        ];
        return values.every((value) =>
          form.connectionFields.every(
            (field) =>
              connectionFieldShown(fromDeclaration, field, { [controller]: value }) ===
              connectionFieldShown(form, field, { [controller]: value }),
          ),
        );
      });
    };

    expect(differing(matches)).toEqual([]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => declared(type).connection.dialog.shownWhen.length > 0)).toEqual([
      "snowflake",
    ]);
  });

  test("connection.hostUriSchemes is the form's hostAcceptsUri, in order", () => {
    expect(
      differing((type, d) => sameList(d.connection.hostUriSchemes, CONNECTION_FORM[type].hostAcceptsUri ?? [])),
    ).toEqual([]);
  });

  test("connection.credentialWarnings is the engine's CREDENTIAL_WARNINGS row, and the form reads that same row", () => {
    expect(differing((type, d) => sameValue(d.connection.credentialWarnings, CREDENTIAL_WARNINGS[type] ?? []))).toEqual(
      [],
    );
    expect(
      SHIPPED_DATABASE_TYPES.filter(
        (type) =>
          CREDENTIAL_WARNINGS[type] !== undefined &&
          CONNECTION_FORM[type].credentialWarnings !== CREDENTIAL_WARNINGS[type],
      ),
    ).toEqual([]);
  });

  test("connection.fieldRules are the form's fieldRules, each pattern by its source and flags", () => {
    const fromDeclaration = (d: EngineDeclaration) =>
      byField(d.connection.fieldRules, (rule) => ({
        required: rule.required,
        format:
          rule.format === null
            ? null
            : { source: rule.format.pattern.source, flags: rule.format.pattern.flags, sentence: rule.format.sentence },
        charRange: rule.charRange,
        check: rule.check !== null,
      }));
    const fromForm = (type: DatabaseType) =>
      Object.fromEntries(
        Object.entries(asMap<ConnectionFieldRule>(CONNECTION_FORM[type].fieldRules)).map(([field, rule]) => [
          field,
          {
            required: rule.required ?? null,
            format:
              rule.format === undefined
                ? null
                : {
                    source: rule.format.pattern.source,
                    flags: rule.format.pattern.flags,
                    sentence: rule.format.sentence,
                  },
            charRange: rule.charRange === undefined ? null : { ...rule.charRange },
            check: rule.check !== undefined,
          },
        ]),
      );

    expect(differing((type, d) => sameValue(fromDeclaration(d), fromForm(type)))).toEqual([]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => declared(type).connection.fieldRules.length > 0).length).toBe(6);
  });

  test("a form whose rules are read from the declaration refuses exactly what the connection form refuses", () => {
    const corpus: readonly unknown[] = [
      undefined,
      null,
      "",
      "   ",
      "a",
      "x".repeat(600),
      "\u00e9t\u00e9",
      "a b",
      "default, kube-system,monitoring",
      "/k8s/clusters/c-m-12345",
      "5432",
      "70000",
      "`sales data`",
      "myorg-myaccount",
      "https://myorg-myaccount.snowflakecomputing.com",
      "xy12345.privatelink",
      crypto.randomUUID(),
    ];
    const readForm = (type: DatabaseType, d: EngineDeclaration): ConnectionFormSpec => {
      const form = CONNECTION_FORM[type];
      return {
        label: form.label,
        defaultPort: form.defaultPort,
        showConnectionStringToggle: form.showConnectionStringToggle,
        connectionFields: d.connection.fields as readonly ConnectionField[],
        fieldShownWhen: byField(d.connection.dialog.shownWhen, ({ when }) => ({
          field: when.field as ConnectionField,
          equals: when.equals,
        })),
        fieldDefaults: byField(d.connection.dialog.absentValues, (entry) => entry.value),
        fieldRules: byField(d.connection.fieldRules, (rule): ConnectionFieldRule => {
          const check = rule.check === null ? undefined : resolveNamed(type, rule.check);
          return {
            ...(rule.required === null ? {} : { required: rule.required }),
            ...(rule.format === null
              ? {}
              : {
                  format: {
                    pattern: new RegExp(rule.format.pattern.source, rule.format.pattern.flags),
                    sentence: rule.format.sentence,
                  },
                }),
            ...(rule.charRange === null ? {} : { charRange: rule.charRange }),
            ...(check === undefined ? {} : { check: check as ConnectionFieldRule["check"] }),
          };
        }),
      };
    };
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const form = CONNECTION_FORM[type];
      const fromDeclaration = readForm(type, d);
      const controllers = [...new Set(d.connection.dialog.shownWhen.map(({ when }) => when.field))];
      const states: Record<string, unknown>[] = [
        {},
        ...controllers.flatMap((controller) =>
          [...(form.fieldOptions?.[controller as ConnectionField] ?? []).map((choice) => choice.value), undefined].map(
            (value) => ({ [controller]: value }),
          ),
        ),
      ];
      const fields = d.connection.fieldRules.map((rule) => rule.field as ConnectionField);
      const connection = (values: Record<string, unknown>) =>
        ({ id: `census-${type}`, name: `census-${type}`, type, ...values }) as DatabaseConnection;
      return states.every((state) =>
        corpus.every(
          (value) =>
            // Every rule field alone, so a later field's rule is reached past an earlier field's required rule.
            fields.every(
              (field) =>
                connectionFieldRefusal(
                  { ...fromDeclaration, connectionFields: [field] },
                  connection({ ...state, [field]: value }),
                ) ===
                connectionFieldRefusal(
                  { ...form, connectionFields: [field] },
                  connection({ ...state, [field]: value }),
                ),
            ) &&
            // And the whole form, every rule field holding the value, in field order.
            connectionFieldRefusal(
              fromDeclaration,
              connection({ ...Object.fromEntries(fields.map((field) => [field, value])), ...state }),
            ) ===
              connectionFieldRefusal(
                form,
                connection({ ...Object.fromEntries(fields.map((field) => [field, value])), ...state }),
              ),
        ),
      );
    };

    expect(differing(matches)).toEqual([]);
  });

  test("every function a declaration names is, through the census's own resolver, the very function the connection form runs", async () => {
    const checks = SHIPPED_DATABASE_TYPES.flatMap((type) => {
      const form = CONNECTION_FORM[type];
      const { connection } = declared(type);
      const same = (name: string | null, held: unknown) =>
        name === null || (held !== undefined && resolveNamed(type, name) === held);
      const ruleChecks = connection.fieldRules.every((rule) =>
        same(rule.check, form.fieldRules?.[rule.field as ConnectionField]?.check),
      );
      const readers = same(connection.hostHint, form.hostHint) && same(connection.hostIdentity, form.hostIdentity);
      const imported = connection.import;
      const load = form.connectionImport?.load;
      const importer: Promise<boolean> =
        imported === null
          ? Promise.resolve(true)
          : load === undefined
            ? Promise.resolve(false)
            : load().then((loaded) => resolveNamed(type, imported.importer) === loaded);
      return [importer.then((importerMatches) => (ruleChecks && readers && importerMatches ? [] : [type]))];
    });

    expect((await Promise.all(checks)).flat()).toEqual([]);
    expect(
      resolveNamed(
        "snowflake",
        declared("snowflake").connection.fieldRules.find((r) => r.field === "host")?.check ?? "",
      ),
    ).toBe(snowflakeAccountRefusal);
    expect(CONNECTION_FORM.snowflake.fieldRules?.host?.check).toBe(snowflakeAccountRefusal);
  });

  test("every function the connection form holds is named by its engine's declaration, and the resolver names nothing else", () => {
    expect(
      differing((type, d) => sameValue(sorted(functionPaths(CONNECTION_FORM[type], "")), sorted(namedSlotPaths(d)))),
    ).toEqual([]);
    const named = (type: DatabaseType): string[] => {
      const { connection } = declared(type);
      return [
        ...connection.fieldRules.flatMap((rule) => (rule.check === null ? [] : [rule.check])),
        ...(connection.hostHint === null ? [] : [connection.hostHint]),
        ...(connection.hostIdentity === null ? [] : [connection.hostIdentity]),
        ...(connection.import === null ? [] : [connection.import.importer]),
        ...connectionStringNames(declared(type)),
        ...sqlTextNames(declared(type)),
      ];
    };
    const unnamed = Object.entries(NAMED_FUNCTIONS).flatMap(([type, table]) =>
      Object.keys(table ?? {})
        .filter((name) => !named(type as DatabaseType).includes(name))
        .map((name) => `${type}.${name}`),
    );

    expect(unnamed).toEqual([]);
    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) => namedSlotPaths(declared(type)).map((slot) => `${type}.${slot}`)),
    ).toEqual([
      "snowflake.fieldRules.host.check",
      "snowflake.hostHint",
      "snowflake.hostIdentity",
      "kubernetes.connectionImport.load",
    ]);
  });

  test("connection.hostHint, hostIdentity and import are the form's, the import with its label", () => {
    expect(
      differing((type, d) => (d.connection.hostHint !== null) === (CONNECTION_FORM[type].hostHint !== undefined)),
    ).toEqual([]);
    expect(
      differing(
        (type, d) => (d.connection.hostIdentity !== null) === (CONNECTION_FORM[type].hostIdentity !== undefined),
      ),
    ).toEqual([]);
    expect(
      differing(
        (type, d) => (d.connection.import?.label ?? null) === (CONNECTION_FORM[type].connectionImport?.label ?? null),
      ),
    ).toEqual([]);
  });

  test("every member of a connection form entry has its member in the declaration", () => {
    const declaredAt: Readonly<Record<keyof ConnectionFormSpec, string>> = {
      label: "displayName",
      defaultPort: "connection.defaults",
      defaultHost: "connection.defaults",
      showConnectionStringToggle: "connection.connectionString",
      connectionFields: "connection.fields",
      dialogOrder: "connection.dialog.order",
      fieldLabels: "connection.dialog.labels",
      fieldHints: "connection.dialog.hints",
      fieldPlaceholders: "connection.dialog.placeholders",
      fieldPlacement: "connection.dialog.placement",
      hostHint: "connection.hostHint",
      hostIdentity: "connection.hostIdentity",
      fieldRules: "connection.fieldRules",
      fieldOptions: "connection.dialog.options",
      fieldShownWhen: "connection.dialog.shownWhen",
      fieldDefaults: "connection.dialog.absentValues",
      showSslPanel: "connection.tls",
      hostAcceptsUri: "connection.hostUriSchemes",
      credentialWarnings: "connection.credentialWarnings",
      connectionImport: "connection.import",
    };
    const at = (value: unknown, dotted: string): unknown =>
      dotted.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], value);

    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) =>
        Object.keys(CONNECTION_FORM[type])
          .filter((member) => !Object.hasOwn(declaredAt, member))
          .map((member) => `${type}.${member}`),
      ),
    ).toEqual([]);
    expect(differing((_type, d) => Object.values(declaredAt).every((member) => at(d, member) !== undefined))).toEqual(
      [],
    );
  });

  test("connection.connectionString.scheme is the row's scheme", () => {
    expect(differing((type, d) => d.connection.connectionString.scheme === CONNECTION_STRING[type].scheme)).toEqual([]);
    expect(
      SHIPPED_DATABASE_TYPES.filter((type) => declared(type).connection.connectionString.scheme !== null).length,
    ).toBe(11);
  });

  test("connection.connectionString names a URL TLS reader, a paste reader and a seed check exactly where the row has one, the paste with its catch-all and formats in order", () => {
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const row = CONNECTION_STRING[type];
      const { urlTls, paste, seedCheck } = d.connection.connectionString;
      const pasteMatches =
        row.paste === null || paste === null
          ? row.paste === paste
          : paste.catchAll === row.paste.catchAll && sameList(paste.formats, row.paste.formats);
      return (
        (urlTls !== null) === (row.readTls !== null) &&
        (seedCheck !== null) === (row.validateSeed !== null) &&
        pasteMatches
      );
    };
    const count = (has: (offer: EngineDeclaration["connection"]["connectionString"]) => boolean) =>
      SHIPPED_DATABASE_TYPES.filter((type) => has(declared(type).connection.connectionString)).length;

    expect(differing(matches)).toEqual([]);
    expect(count((offer) => offer.paste !== null)).toBe(13);
    expect(count((offer) => offer.urlTls !== null)).toBe(4);
    expect(count((offer) => offer.seedCheck !== null)).toBe(3);
    expect(
      count(
        (offer) => offer.scheme === null && offer.urlTls === null && offer.paste === null && offer.seedCheck === null,
      ),
    ).toBe(28);
  });

  test("every function a connection string row holds is, through the census's own resolver, the very slot its declaration names", () => {
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const row = CONNECTION_STRING[type];
      const { urlTls, paste, seedCheck } = d.connection.connectionString;
      const same = (name: string | null, held: unknown) =>
        name === null ? held === null : held !== null && resolveNamed(type, name) === held;
      const reader =
        paste === null ? undefined : (resolveNamed(type, paste.reader) as ConnectionStringPaste | undefined);
      const readerOperations =
        reader === undefined ||
        (typeof reader.claims === "function" &&
          typeof reader.names === "function" &&
          typeof reader.parse === "function");
      return (
        same(urlTls, row.readTls) &&
        same(paste?.reader ?? null, row.paste) &&
        same(seedCheck, row.validateSeed) &&
        readerOperations
      );
    };

    expect(differing(matches)).toEqual([]);
    expect(resolveNamed("postgres", "urlTls")).toBe(CONNECTION_STRING.postgres.readTls);
    expect(resolveNamed("snowflake", "seedCheck")).toBe(CONNECTION_STRING.snowflake.validateSeed);
  });

  test("every function a connection string row holds is named by its engine's declaration", () => {
    expect(
      differing((type, d) =>
        sameValue(sorted(functionPaths(CONNECTION_STRING[type], "")), sorted(connectionStringSlotPaths(d))),
      ),
    ).toEqual([]);
    expect(SHIPPED_DATABASE_TYPES.flatMap((type) => connectionStringSlotPaths(declared(type))).length).toBe(
      13 * 3 + 4 + 3,
    );
  });

  test("ENGINE_URI_SCHEMES is the scheme of each declaration that states one", () => {
    const fromDeclarations = Object.fromEntries(
      SHIPPED_DATABASE_TYPES.flatMap((type) => {
        const { scheme } = declared(type).connection.connectionString;
        return scheme === null ? [] : [[type, scheme]];
      }),
    );

    expect(sameValue(ENGINE_URI_SCHEMES, fromDeclarations)).toBe(true);
  });

  test("the Paste URL box's formats are the declarations' formats in the engine picker's order", () => {
    const fromDeclarations = CONNECTION_PICKER_ORDER.flatMap(
      (type) => declared(type).connection.connectionString.paste?.formats ?? [],
    ).join(", ");

    expect(PASTE_FORMATS_TEXT).toBe(fromDeclarations);
  });

  test("core's paste order walks exactly the engines whose declaration names a paste reader, every catch-all after the rest", () => {
    const pasteOf = (type: DatabaseType) => declared(type).connection.connectionString.paste;
    const readers = SHIPPED_DATABASE_TYPES.filter((type) => pasteOf(type) !== null);
    const catchAlls = CONNECTION_STRING_PASTE_ORDER.map((type) => pasteOf(type)?.catchAll === true);
    const firstCatchAll = catchAlls.indexOf(true);

    expect(sorted(CONNECTION_STRING_PASTE_ORDER)).toEqual(sorted(readers));
    expect(new Set(CONNECTION_STRING_PASTE_ORDER).size).toBe(CONNECTION_STRING_PASTE_ORDER.length);
    expect(firstCatchAll).toBeGreaterThan(0);
    expect(catchAlls.slice(firstCatchAll).every(Boolean)).toBe(true);
    expect(
      CONNECTION_STRING_PASTE_OVERLAPS.filter(
        ({ first, second }) => pasteOf(first) === null || pasteOf(second) === null,
      ),
    ).toEqual([]);
  });

  test("a parser walking core's paste order over the readers the declarations name parses and detects as the parser does", () => {
    const rows = CONNECTION_STRING_PASTE_ORDER.map((type) => {
      const paste = declared(type).connection.connectionString.paste;
      return {
        type,
        reader: (paste === null ? undefined : resolveNamed(type, paste.reader)) as ConnectionStringPaste,
      };
    });
    const parse = (input: string) => {
      const text = pasteText(input);
      if (!text) return null;
      const row = rows.find(({ reader }) => reader.claims(text));
      return row === undefined ? null : row.reader.parse(text);
    };
    const detect = (input: string) => {
      const text = input.trim().toLowerCase();
      return rows.find(({ reader }) => reader.names(text))?.type ?? null;
    };
    const schemes = SHIPPED_DATABASE_TYPES.flatMap((type) => {
      const { scheme } = declared(type).connection.connectionString;
      return scheme === null ? [] : [`${scheme}://h:1/d`];
    });
    const corpus = [
      ...CONNECTION_STRING_PASTE_OVERLAPS.map((overlap) => overlap.text),
      ...schemes,
      "postgresql://h/d",
      "mongodb+srv://h/d",
      "rediss://h",
      "couchbases://h",
      "sqlserver://h",
      "http://h",
      "https://h:8443",
      "Server=h;Database=d",
      "BENDSQL_DSN=databend://u@h:8000/d",
      "sc://h:15002",
      "jdbc:sc://h:15002",
      "jdbc:snowflake://x.snowflakecomputing.com",
      "x.snowflakecomputing.com",
      "a text with a space",
      "",
      crypto.randomUUID(),
    ];

    expect(schemes.length).toBe(11);
    expect(corpus.filter((text) => !Bun.deepEquals(parse(text), parseConnectionString(text)))).toEqual([]);
    expect(corpus.filter((text) => detect(text) !== detectConnectionStringType(text))).toEqual([]);
    expect(corpus.filter((text) => parseConnectionString(text) !== null).length).toBeGreaterThan(20);
  });

  test("every member of a connection string row has its member in the declaration", () => {
    const declaredAt: Readonly<Record<keyof ConnectionStringSpec, string>> = {
      scheme: "scheme",
      readTls: "urlTls",
      paste: "paste",
      validateSeed: "seedCheck",
    };
    const pasteDeclaredAt: Readonly<Record<keyof ConnectionStringPaste, string>> = {
      catchAll: "catchAll",
      claims: "reader",
      names: "reader",
      parse: "reader",
      formats: "formats",
    };

    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) => {
        const row = CONNECTION_STRING[type];
        return [
          ...Object.keys(row).filter((member) => !Object.hasOwn(declaredAt, member)),
          ...Object.keys(row.paste ?? {}).filter((member) => !Object.hasOwn(pasteDeclaredAt, member)),
        ].map((member) => `${type}.${member}`);
      }),
    ).toEqual([]);
    expect(
      differing((_type, d) => {
        const offer = d.connection.connectionString;
        const paste = offer.paste;
        return (
          Object.values(declaredAt).every((member) => Object.hasOwn(offer, member)) &&
          (paste === null || Object.values(pasteDeclaredAt).every((member) => Object.hasOwn(paste, member)))
        );
      }),
    ).toEqual([]);
  });

  test("editor.commitKeyword and editor.consentDeadline are the engine's EXECUTION_UI row", () => {
    expect(
      differing((type, d) => {
        const row = EXECUTION_UI[type];
        return d.editor.commitKeyword === row.commitKeyword && sameValue(d.editor.consentDeadline, row.consentDeadline);
      }),
    ).toEqual([]);
    // Vacuity: the rows hold a keyword other than COMMIT and a deadline, so neither member is read back as a constant.
    expect(new Set(SHIPPED_DATABASE_TYPES.map((type) => declared(type).editor.commitKeyword)).size).toBeGreaterThan(1);
    expect(SHIPPED_DATABASE_TYPES.some((type) => declared(type).editor.consentDeadline !== null)).toBe(true);
  });

  test("executionUiFor answers, for every engine, the spec its declaration states", () => {
    expect(
      differing((type, d) => {
        const spec: ExecutionUiSpec = {
          commitKeyword: d.editor.commitKeyword,
          consentDeadline:
            d.editor.consentDeadline === null
              ? null
              : { chip: d.editor.consentDeadline.chip, sentence: d.editor.consentDeadline.sentence },
        };
        return sameValue(executionUiFor(type), spec);
      }),
    ).toEqual([]);
  });

  test("every member of an execution UI row has its member in the declaration", () => {
    const declaredAt: Readonly<Record<keyof ExecutionUiSpec, string>> = {
      commitKeyword: "commitKeyword",
      consentDeadline: "consentDeadline",
    };
    const deadlineDeclaredAt: Readonly<Record<keyof ConsentDeadline, string>> = { chip: "chip", sentence: "sentence" };

    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) => {
        const row = EXECUTION_UI[type];
        return [
          ...Object.keys(row).filter((member) => !Object.hasOwn(declaredAt, member)),
          ...Object.keys(row.consentDeadline ?? {}).filter((member) => !Object.hasOwn(deadlineDeclaredAt, member)),
        ].map((member) => `${type}.${member}`);
      }),
    ).toEqual([]);
    expect(
      differing((_type, d) => {
        const deadline = d.editor.consentDeadline;
        return (
          Object.values(declaredAt).every((member) => Object.hasOwn(d.editor, member)) &&
          (deadline === null || Object.values(deadlineDeclaredAt).every((member) => Object.hasOwn(deadline, member)))
        );
      }),
    ).toEqual([]);
  });

  test("editor.fenceAliases are the aliases ALIAS_ENGINES maps to the engine", () => {
    expect(
      differing((type, d) => {
        const aliases = Object.keys(ALIAS_ENGINES).filter((alias) => ALIAS_ENGINES[alias] === type);
        return sameList(sorted(d.editor.fenceAliases), sorted(aliases));
      }),
    ).toEqual([]);
  });

  test("ALIAS_ENGINES and QUERY_FENCE_ALIASES are the declarations' aliases and the schema's generic fence tags", () => {
    const derived = Object.fromEntries(
      SHIPPED_DATABASE_TYPES.flatMap((type) => declared(type).editor.fenceAliases.map((alias) => [alias, type])),
    );
    const aliases = SHIPPED_DATABASE_TYPES.flatMap((type) => declared(type).editor.fenceAliases);

    expect(derived).toEqual({ ...ALIAS_ENGINES });
    expect(aliases.length).toBe(Object.keys(ALIAS_ENGINES).length);
    expect(sorted([...QUERY_FENCE_ALIASES])).toEqual(sorted([...aliases, ...GENERIC_FENCE_TAGS]));
  });

  test("a reader built from the declarations names and admits every fence tag as fenceTagEngine and isQueryFenceTag do", () => {
    const ids = new Set<string>(SHIPPED_DATABASE_TYPES);
    const aliasEngine = new Map<string, DatabaseType>(
      SHIPPED_DATABASE_TYPES.flatMap((type) => declared(type).editor.fenceAliases.map((alias) => [alias, type])),
    );
    const generic = new Set(GENERIC_FENCE_TAGS);
    const engineOf = (tag: string | undefined): DatabaseType | null => {
      if (tag === undefined) return null;
      if (ids.has(tag)) return tag as DatabaseType;
      return aliasEngine.get(tag) ?? null;
    };
    const holdsQuery = (tag: string | undefined): boolean =>
      tag === undefined || ids.has(tag) || aliasEngine.has(tag) || generic.has(tag);
    const corpus: (string | undefined)[] = [
      ...SHIPPED_DATABASE_TYPES,
      ...aliasEngine.keys(),
      "sql",
      "cql",
      "sh",
      "json",
      "presto",
      "es",
      "flux",
      "Postgres",
      "constructor",
      "__proto__",
      "toString",
      "",
      undefined,
      crypto.randomUUID(),
    ];

    expect(
      corpus.filter((tag) => engineOf(tag) !== fenceTagEngine(tag) || holdsQuery(tag) !== isQueryFenceTag(tag)),
    ).toEqual([]);
    // Vacuity: the corpus holds tags that name an engine, tags that hold a query and name none, and tags that hold none.
    expect(corpus.filter((tag) => engineOf(tag) !== null).length).toBe(ids.size + aliasEngine.size);
    expect(corpus.filter((tag) => holdsQuery(tag) && engineOf(tag) === null)).toEqual(["sql", "cql", undefined]);
    expect(corpus.filter((tag) => !holdsQuery(tag)).length).toBe(11);
  });

  test("editor.explainFormat is the format the engine's unconnected provider declares, null exactly where it supports no explain", () => {
    expect(
      differing((type, d) => {
        const capabilities = CAPABILITIES[type];
        return (
          d.editor.explainFormat === (capabilities.explainFormat ?? null) &&
          (d.editor.explainFormat === null) === !capabilities.supportsExplain
        );
      }),
    ).toEqual([]);
  });

  test("the census reads each provider's capabilities in its stated environment, so a variable set where it runs changes none", async () => {
    const ambient = process.env[FIRESTORE_EMULATOR_VARIABLE];
    process.env[FIRESTORE_EMULATOR_VARIABLE] = "127.0.0.1:1";
    try {
      const inProcess = (await createDatabaseProvider(CENSUS_CONNECTION.firestore)).getCapabilities();
      const census = await readCensusCapabilities();

      // Vacuity: the variable changes what the provider declares when it is read in this process.
      expect(inProcess.explainFormat).toBeUndefined();
      expect(census.firestore.explainFormat).toBeDefined();
      expect(census.firestore.explainFormat).toBe(declared("firestore").editor.explainFormat ?? undefined);
      expect(census).toEqual(CAPABILITIES);
    } finally {
      if (ambient === undefined) delete process.env[FIRESTORE_EMULATOR_VARIABLE];
      else process.env[FIRESTORE_EMULATOR_VARIABLE] = ambient;
    }
  });

  test("every declared explain format has Studio's strategy for it", () => {
    const formats = SHIPPED_DATABASE_TYPES.map((type) => declared(type).editor.explainFormat).filter(
      (format) => format !== null,
    );

    expect(formats.length).toBeGreaterThan(0);
    expect(formats.filter((format) => getExplainStrategy(format)?.format !== format)).toEqual([]);
  });

  test("editor.dialect is the provider's query dialect with its QUERY_DIALECTS row", () => {
    expect(
      differing((type, d) => {
        const dialect = CAPABILITIES[type].queryDialect;
        if (dialect === undefined) return d.editor.dialect === null;
        const row = QUERY_DIALECTS[dialect];
        return sameValue(d.editor.dialect, {
          name: dialect,
          offersColumnProfiling: row.offersColumnProfiling,
          offersCodeGeneration: row.offersCodeGeneration,
          offersCountQuery: row.offersCountQuery,
          offersSqlExport: row.offersSqlExport !== false,
          historyMask: row.historyMask ?? null,
        });
      }),
    ).toEqual([]);
  });

  test("QUERY_DIALECTS is the dialect rows the declarations state, one per dialect, each opening tabs of its own name", () => {
    const derived = derivedDialects();
    const resolved = (spec: DialectSpec) => ({ ...spec, offersSqlExport: spec.offersSqlExport !== false });

    expect(sorted(Object.keys(derived))).toEqual(sorted(Object.keys(QUERY_DIALECTS)));
    expect(
      Object.entries(QUERY_DIALECTS)
        .filter(([dialect, spec]) => spec.tabType !== dialect)
        .map(([dialect]) => dialect),
    ).toEqual([]);
    expect(
      (Object.keys(QUERY_DIALECTS) as QueryDialect[]).filter(
        (dialect) => !sameValue(resolved(derived[dialect]), resolved(QUERY_DIALECTS[dialect])),
      ),
    ).toEqual([]);
  });

  test("history keeps no value of a flag the declarations name, as it keeps none of the registry's", () => {
    const derived = derivedDialects();

    expect(historyMaskOf(undefined, derived)).toEqual(historyMaskOf(undefined));
    expect(historyMaskOf(undefined)).toBeDefined();
    expect(
      SHIPPED_DATABASE_TYPES.filter(
        (type) => !sameValue(historyMaskOf(CAPABILITIES[type], derived), historyMaskOf(CAPABILITIES[type])),
      ),
    ).toEqual([]);
  });

  test("every member of a dialect row has its member in the declaration", () => {
    const declaredAt: Readonly<Record<keyof DialectSpec, string>> = {
      tabType: "name",
      offersColumnProfiling: "offersColumnProfiling",
      offersCodeGeneration: "offersCodeGeneration",
      offersCountQuery: "offersCountQuery",
      offersSqlExport: "offersSqlExport",
      historyMask: "historyMask",
    };
    const maskDeclaredAt: Readonly<Record<keyof NonNullable<DialectSpec["historyMask"]>, string>> = {
      credentialFlags: "credentialFlags",
    };

    expect(
      Object.entries(QUERY_DIALECTS).flatMap(([dialect, row]) =>
        [
          ...Object.keys(row).filter((member) => !Object.hasOwn(declaredAt, member)),
          ...Object.keys(row.historyMask ?? {}).filter((member) => !Object.hasOwn(maskDeclaredAt, member)),
        ].map((member) => `${dialect}.${member}`),
      ),
    ).toEqual([]);
    expect(
      differing((_type, d) => {
        const row = d.editor.dialect;
        if (row === null) return true;
        const mask = row.historyMask;
        return (
          Object.values(declaredAt).every((member) => Object.hasOwn(row, member)) &&
          (mask === null || Object.values(maskDeclaredAt).every((member) => Object.hasOwn(mask, member)))
        );
      }),
    ).toEqual([]);
  });

  test("sqlText.readsSqlText is the engine's SQL_GRAMMAR row's", () => {
    expect(differing((type, d) => d.sqlText.readsSqlText === SQL_GRAMMAR[type].readsSqlText)).toEqual([]);
    // Vacuity: some engines read SQL text and some do not, so the member is not read back as a constant.
    expect(new Set(SHIPPED_DATABASE_TYPES.map((type) => declared(type).sqlText.readsSqlText)).size).toBe(2);
  });

  test("sqlText.grammar is the row's grammar, each fact the row leaves out at its reading when left out and each trailing limit clause by its source and flags", () => {
    expect(differing((type, d) => sameValue(d.sqlText.grammar, declaredGrammar(SQL_GRAMMAR[type].grammar)))).toEqual(
      [],
    );
    // Vacuity: some row states each nullable fact and some row leaves it out, some row turns tagged runs off, and some
    // row declares more than one clause, whose order sameValue keeps.
    const facts = SHIPPED_DATABASE_TYPES.map((type) => declared(type).sqlText.grammar);
    for (const member of ["doubleQuoteBackslashEscapes", "singleQuoteBackslashEscapes", "confirmConfigKeys"] as const) {
      expect(facts.some((grammar) => grammar[member] === null)).toBe(true);
      expect(facts.some((grammar) => grammar[member] !== null)).toBe(true);
    }
    expect(facts.some((grammar) => !grammar.dollarTags)).toBe(true);
    expect(facts.some((grammar) => grammar.trailingLimitClauses.length > 1)).toBe(true);
  });

  test("a grammar read from the declaration reads every statement of the census corpus as the row's grammar does", () => {
    const corpus = censusCorpus();

    expect(
      differing((type, d) => {
        const row = SQL_GRAMMAR[type].grammar;
        const read = grammarFromDeclaration(d);
        return (
          sameList(
            read.trailingLimitClauses.map(({ source, flags }) => `/${source}/${flags}`),
            row.trailingLimitClauses.map(({ source, flags }) => `/${source}/${flags}`),
          ) && corpus.every((sql) => sameValue(readings(sql, read), readings(sql, row)))
        );
      }),
    ).toEqual([]);
    // Vacuity: the corpus reads differently under many engines' grammars, so it reaches the facts that tell them apart.
    const answers = new Set(
      SHIPPED_DATABASE_TYPES.map((type) =>
        JSON.stringify(corpus.map((sql) => readings(sql, SQL_GRAMMAR[type].grammar))),
      ),
    );
    expect(answers.size).toBeGreaterThan(10);
  });

  test("sqlText.redaction is the row's redaction, a command reader named by its slot", () => {
    expect(
      differing((type, d) => {
        const row = SQL_GRAMMAR[type].redaction;
        const expected =
          row.kind === "sql"
            ? { kind: "sql", nameQuote: row.nameQuote }
            : row.kind === "command"
              ? { kind: "command", reader: "redactionReader" }
              : { kind: "none" };
        return sameValue(d.sqlText.redaction, expected);
      }),
    ).toEqual([]);
    // Vacuity: every kind and more than one name quote are declared.
    const redactions = SHIPPED_DATABASE_TYPES.map((type) => declared(type).sqlText.redaction);
    expect(new Set(redactions.map(({ kind }) => kind)).size).toBe(3);
    expect(new Set(redactions.flatMap((r) => (r.kind === "sql" ? [r.nameQuote] : []))).size).toBe(4);
  });

  test("sqlText.updateTarget is the row's, each word set in its order", () => {
    expect(
      differing((type, d) => {
        const row = SQL_GRAMMAR[type].updateTarget;
        const words = d.sqlText.updateTarget;
        return (
          words.dashCommentNeedsSeparator === row.dashCommentNeedsSeparator &&
          sameList(words.extraQueryOpeners, [...row.extraQueryOpeners]) &&
          sameList(words.extraSetOperators, [...row.extraSetOperators])
        );
      }),
    ).toEqual([]);
    // Vacuity: each member is stated other than empty or false on some engine.
    const targets = SHIPPED_DATABASE_TYPES.map((type) => declared(type).sqlText.updateTarget);
    expect(targets.some((target) => target.dashCommentNeedsSeparator)).toBe(true);
    expect(targets.some((target) => target.extraQueryOpeners.length > 1)).toBe(true);
    expect(targets.some((target) => target.extraSetOperators.length > 0)).toBe(true);
  });

  test("sqlText.completion names a segment formatter and a quoted qualifier reader exactly where the row has one", () => {
    expect(
      differing((type, d) => {
        const row = SQL_GRAMMAR[type].completion;
        return sameValue(d.sqlText.completion, {
          formatSegment: row.formatSegment === null ? null : "formatSegment",
          readQuotedQualifier: row.readQuotedQualifier === null ? null : "readQuotedQualifier",
        });
      }),
    ).toEqual([]);
  });

  test("every function a grammar row holds is, through the census's own resolver, the very slot its declaration names", () => {
    expect(
      differing((type, d) => {
        const row = SQL_GRAMMAR[type];
        const { redaction, completion } = d.sqlText;
        const same = (name: string | null, held: unknown) =>
          name === null || (typeof held === "function" && resolveNamed(type, name) === held);
        return (
          (redaction.kind !== "command" || same(redaction.reader, commandReader(row.redaction))) &&
          same(completion.formatSegment, row.completion.formatSegment) &&
          same(completion.readQuotedQualifier, row.completion.readQuotedQualifier)
        );
      }),
    ).toEqual([]);
    expect(resolveNamed("postgres", "readQuotedQualifier")).toBe(SQL_GRAMMAR.postgres.completion.readQuotedQualifier);
    expect(typeof resolveNamed("postgres", "readQuotedQualifier")).toBe("function");
  });

  test("every function a grammar row holds is named by its engine's declaration", () => {
    expect(
      differing((type, d) => sameValue(sorted(functionPaths(SQL_GRAMMAR[type], "")), sorted(sqlTextSlotPaths(d)))),
    ).toEqual([]);
    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) => sqlTextSlotPaths(declared(type)).map((slot) => `${type}.${slot}`)),
    ).toEqual([
      "postgres.completion.formatSegment",
      "postgres.completion.readQuotedQualifier",
      "mongodb.redaction.read",
      "redis.redaction.read",
    ]);
  });

  test("every member of a grammar row has its member in the declaration", () => {
    const specDeclaredAt: Readonly<Record<keyof SqlGrammarSpec, string>> = {
      grammar: "grammar",
      readsSqlText: "readsSqlText",
      redaction: "redaction",
      updateTarget: "updateTarget",
      completion: "completion",
    };
    const grammarDeclaredAt: Readonly<Record<keyof SqlGrammar, string>> = {
      hash: "hash",
      bracket: "bracket",
      blockComment: "blockComment",
      alternateQuoting: "alternateQuoting",
      doubleSlashComment: "doubleSlashComment",
      backslashAlwaysEscapes: "backslashAlwaysEscapes",
      tripleQuotedStrings: "tripleQuotedStrings",
      backtickBackslashEscapes: "backtickBackslashEscapes",
      dollarTags: "dollarTags",
      doubleQuoteBackslashEscapes: "doubleQuoteBackslashEscapes",
      singleQuoteBackslashEscapes: "singleQuoteBackslashEscapes",
      rawStrings: "rawStrings",
      hintsAreCode: "hintsAreCode",
      lineCommentBackslashContinues: "lineCommentBackslashContinues",
      lineCommentEndsAtCarriageReturn: "lineCommentEndsAtCarriageReturn",
      script: "script",
      trailingLimitClauses: "trailingLimitClauses",
      nonNumericRowBounds: "nonNumericRowBounds",
      confirmForms: "confirmForms",
      confirmCodeForms: "confirmCodeForms",
      confirmFormsWhen: "confirmFormsWhen",
      confirmExemptForms: "confirmExemptForms",
      formatterLanguage: "formatterLanguage",
      completionWords: "completionWords",
      confirmConfigKeys: "confirmConfigKeys",
      explainExecutesWithAnalyze: "explainExecutesWithAnalyze",
    };
    const scriptDeclaredAt: Readonly<Record<keyof ScriptGrammar, string>> = {
      blocks: "blocks",
      separatorLine: "separatorLine",
      unit: "unit",
      terminatedStatements: "terminatedStatements",
    };
    const redactionDeclaredAt: Readonly<Record<RedactionMember, string>> = {
      kind: "kind",
      nameQuote: "nameQuote",
      read: "reader",
    };
    const updateTargetDeclaredAt: Readonly<Record<keyof UpdateTargetGrammar, string>> = {
      dashCommentNeedsSeparator: "dashCommentNeedsSeparator",
      extraQueryOpeners: "extraQueryOpeners",
      extraSetOperators: "extraSetOperators",
    };
    const completionDeclaredAt: Readonly<Record<keyof CompletionQuoting, string>> = {
      formatSegment: "formatSegment",
      readQuotedQualifier: "readQuotedQualifier",
    };
    const unplaced = (row: object, declaredAt: object, at: string) =>
      Object.keys(row)
        .filter((member) => !Object.hasOwn(declaredAt, member))
        .map((member) => `${at}${member}`);
    const placed = (declaration: object, declaredAt: object) =>
      Object.values(declaredAt).every((member) => Object.hasOwn(declaration, member));

    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) => {
        const row = SQL_GRAMMAR[type];
        return [
          ...unplaced(row, specDeclaredAt, ""),
          ...unplaced(row.grammar, grammarDeclaredAt, "grammar."),
          ...unplaced(row.grammar.script, scriptDeclaredAt, "grammar.script."),
          ...unplaced(row.redaction, redactionDeclaredAt, "redaction."),
          ...unplaced(row.updateTarget, updateTargetDeclaredAt, "updateTarget."),
          ...unplaced(row.completion, completionDeclaredAt, "completion."),
        ].map((member) => `${type}.${member}`);
      }),
    ).toEqual([]);
    expect(
      differing((type, d) => {
        const { sqlText } = d;
        const redaction = Object.entries(redactionDeclaredAt).every(
          ([member, declaredMember]) =>
            Object.hasOwn(SQL_GRAMMAR[type].redaction, member) === Object.hasOwn(sqlText.redaction, declaredMember),
        );
        return (
          placed(sqlText, specDeclaredAt) &&
          placed(sqlText.grammar, grammarDeclaredAt) &&
          placed(sqlText.grammar.script, scriptDeclaredAt) &&
          redaction &&
          placed(sqlText.updateTarget, updateTargetDeclaredAt) &&
          placed(sqlText.completion, completionDeclaredAt)
        );
      }),
    ).toEqual([]);
  });

  test("id is the file's type-id", () => {
    expect(differing((type, d) => d.id === type)).toEqual([]);
  });
});

/** Whether two types are the same type, checked by the compiler. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe("the vocabularies", () => {
  const enumOf = (name: string): unknown[] => SCHEMA.$defs[name]?.enum ?? [];
  const contractFields = [...Object.keys(CONNECTION_FIELD_DESCRIPTORS), ...SEED_ONLY_FIELD_NAMES];

  test("the schema's field names are the connection fields and the seed-only fields", () => {
    expect(sorted(enumOf("fieldName"))).toEqual(sorted(contractFields));
    expect(sorted(enumOf("seedOnlyFieldName"))).toEqual(sorted(SEED_ONLY_FIELD_NAMES));
  });

  test("the schema's secret, identity and public lists are the storage layer's classes of those fields", () => {
    for (const fieldClass of ["secret", "identity", "public"] as const) {
      const expected = contractFields.filter((field) => FIELD_CLASSES[field as ConnectionField] === fieldClass);

      expect(sorted(enumOf(`${fieldClass}FieldName`))).toEqual(sorted(expected));
    }
    expect(
      sorted([...enumOf("secretFieldName"), ...enumOf("identityFieldName"), ...enumOf("publicFieldName")]),
    ).toEqual(sorted(contractFields));
  });

  test("the monitoring panels are MONITORING_PANELS and the agent readings CURATED_OPERATION_KINDS", () => {
    const panels = SCHEMA.$defs.monitoringPanels;

    expect(Object.keys(panels?.properties ?? {})).toEqual([...MONITORING_PANELS]);
    expect(panels?.required).toEqual([...MONITORING_PANELS]);
    expect(enumOf("agentReading")).toEqual([...CURATED_OPERATION_KINDS]);
  });

  test("the placeable fields are PLACEABLE_FIELDS and the select fields are those the descriptors draw as a select", () => {
    const selects = Object.entries(CONNECTION_FIELD_DESCRIPTORS)
      .filter(([, descriptor]) => descriptor.slot === "body" && descriptor.control.kind === "select")
      .map(([field]) => field);

    expect(sorted(enumOf("placeableFieldName"))).toEqual(sorted(PLACEABLE_FIELDS));
    expect(sorted(enumOf("selectFieldName"))).toEqual(sorted(selects));
  });

  test("the generated unions are Studio's own types", () => {
    const parity: [
      Equal<ManifestMaintenanceOperation, MaintenanceOperation>,
      Equal<Exclude<StatementLanguage, null>, AgentStatementLanguageId>,
      Equal<FieldName, ConnectionField | SeedOnlyField>,
      Equal<AgentCredentialForm, SeedAgentCredential["form"]>,
      Equal<ManifestHostPathField, HostPathField>,
      Equal<ManifestFieldPlacement, FieldPlacement>,
      Equal<ManifestHostUriScheme, HostUriScheme>,
      Equal<ManifestCredentialWarning["kind"], CredentialWarning["kind"]>,
      Equal<JwtAccessClaim, Extract<CredentialWarning, { kind: "jwt" }>["access"][number]>,
      Equal<PlaceableFieldName, PlaceableField>,
      Equal<SelectFieldName, "saslMechanism" | "authMethod">,
      Equal<Exclude<ManifestExplainFormat, null>, ExplainFormat>,
      Equal<ManifestQueryDialect, QueryDialect>,
      Equal<HashRule, HashGrammar>,
      Equal<BracketRule, BracketGrammar>,
      Equal<BlockCommentRule, BlockCommentGrammar>,
      Equal<ProcedureBodies, ProceduralBlockGrammar>,
      Equal<ScriptUnit, ScriptGrammar["unit"]>,
      Equal<ScriptFacts["separatorLine"], ScriptGrammar["separatorLine"]>,
      Equal<Exclude<FormatterLanguage, "postgresql">, NonNullable<SqlGrammar["formatterLanguage"]>>,
      Equal<StatementRedaction["kind"], SqlRedaction["kind"]>,
    ] = [
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ];

    expect<readonly boolean[]>(parity).toEqual(Array.from({ length: 21 }, () => true));
  });

  test("the explain formats, the query dialects and the generic fence tags are Studio's", () => {
    const formats = enumOf("explainFormat").filter((format) => format !== null) as ExplainFormat[];

    expect(enumOf("explainFormat")).toContain(null);
    expect(formats.filter((format) => getExplainStrategy(format)?.format !== format)).toEqual([]);
    expect(sorted(enumOf("queryDialect"))).toEqual(sorted(Object.keys(QUERY_DIALECTS)));
    expect(sorted(enumOf("genericFenceTag"))).toEqual(
      sorted([...QUERY_FENCE_ALIASES].filter((tag) => !Object.hasOwn(ALIAS_ENGINES, tag))),
    );
  });
});
