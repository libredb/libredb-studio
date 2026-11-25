/**
 * One engine declaration per shipped type-id, its authored members written in it and every other member generated from
 * today's per-engine tables, and the census that reads each declaration back to every table it came from
 * (docs/providers/CONTRACT.md, clauses M-9 and M-15).
 *
 * `scripts/generate-engine-declarations.ts` writes `src/lib/db/engine-declarations/<type-id>.json`, one
 * `#/$defs/engineDeclaration` of the provider manifest schema each. The authored members, `AUTHORED_MEMBERS`, are read
 * from the committed file and written back unchanged; the engine catalog, the connection tables, the connection forms,
 * the connection strings, and the execution UI and fence aliases project them (tests/unit/db/engine-catalog.test.ts),
 * so the census of those members reads each table back to the declaration it was projected from: for the connection
 * form, `CONNECTION_FORM` composed from the projection and Studio's function table (src/lib/db/connection-form.ts), for
 * the connection string, `CONNECTION_STRING` composed from the projection and Studio's connection string function table
 * (src/lib/db/connection-string/index.ts), and for the editor, `EXECUTION_UI`, `ALIAS_ENGINES` and
 * `QUERY_FENCE_ALIASES` read from the generated editor record with Studio's generic fence tags. Those tests compare a
 * composition with its source; what the rows do is held by the golden files, the paste tests, the parser tests, the
 * seed tests and the fence tag tests, which read the same rows. The census below
 * does not call the generator: its read-back functions are written here, from the tables, so a slip in the generator
 * cannot certify itself. Each test loops over every shipped id and fails with the list of ids whose declaration and
 * table differ.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CONNECT_BUDGET_MS } from "@libredb/provider-sdk/calls";
import {
  type AgentCredentialForm,
  type AgentCredentialFormClaim,
  type BlockCommentRule,
  type BracketRule,
  type CatalogCompose,
  type CatalogKind,
  compileManifestValidator,
  type CreateTable,
  type CredentialWarning as ManifestCredentialWarning,
  type DdlTypeSpellings,
  type EngineDeclaration,
  type ExplainFormat as ManifestExplainFormat,
  type FieldName,
  type FieldPlacement as ManifestFieldPlacement,
  type FormatterLanguage,
  type GrammarFacts,
  type HashRule,
  type HostPathField as ManifestHostPathField,
  type HostUriScheme as ManifestHostUriScheme,
  type InsertForm,
  type JwtAccessClaim,
  type MaintenanceConfirmation,
  type MaintenanceOperation as ManifestMaintenanceOperation,
  type MaintenanceSpec,
  type McpClaims,
  type MetadataOnlyKind,
  type MigrationDdl,
  type MonacoLanguageId,
  type NonFiniteLiterals,
  type PlaceableFieldName,
  type PlanEstimateSessionMode,
  type PolicyClaims,
  type ProcedureBodies,
  type QueryDialect as ManifestQueryDialect,
  type QueryLanguage,
  type Safeguards,
  type ScriptFacts,
  type ScriptUnit,
  type SelectFieldName,
  type SqlDialect,
  type StatementLanguage,
  type StatementRedaction,
  type TypeFamilies,
  type WritePathEvidence,
  type WritePaths,
  type WriteReachClaim,
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
  AUTHORED_MEMBERS,
  type AuthoredMembers,
  authoredMembersOf,
  buildAgentOverlay,
  buildEditor,
  buildEngineDeclaration,
  CAPABILITY_READ_ENVIRONMENT,
  declarationDirectoryProblems,
  ENGINE_DECLARATIONS_DIRECTORY,
  readEngineCapabilities,
  renderEngineDeclaration,
} from "../../../scripts/generate-engine-declarations";
import { refuseInexactJson } from "../../../scripts/read-engine-capabilities";
import { SEGMENT_CLAIMS } from "./engine-declarations/claims";
import {
  AGENT_REQUIREMENT_ENGINES,
  AGENT_WORKFLOW_VARIANTS,
  type AgentStatementLanguageId,
  workflowAvailability,
} from "@/lib/agent/agent-manifest";
import type { AgentCatalogKind, AgentPlanEstimate } from "@/lib/agent/composed-sql-primitives";
import { enginesSupporting, engineClientPack, engineFamily } from "@/lib/agent/languages/engines/client";
import { engineServerDialect, engineServerOverlay, runServerPack } from "@/lib/agent/languages/engines/server";
import { ENGINE_OVERRIDABLE_SERVER_MEMBERS } from "@/lib/agent/languages/overlay";
import type { AgentEngineServerDialect, SqlServerDialect } from "@/lib/agent/languages/pack";
import { languageServerPack } from "@/lib/agent/languages/server";
import type { AgentRunMode, AgentRunWorkflowType } from "@/lib/agent/types";
import type { HostUriScheme } from "@/lib/connection-host-uri";
import { PASTE_FORMATS_TEXT } from "@/lib/connection-paste-formats";
import { detectConnectionStringType, parseConnectionString, pasteText } from "@/lib/connection-string-parser";
import { READ_ONLY_ENFORCED } from "@/lib/db/claim-grants";
import {
  AGENT_EXECUTION_ENGINES,
  AGENT_STATEMENT_LANGUAGE,
  CONNECTION_FORM_URI_MODE,
  CONNECTION_STRING_ACCEPTED,
  HOST_PATH_FIELDS,
  MASKING_EXEMPT_COLUMNS,
  MCP_AGENT_CREDENTIAL_REQUIRED,
  MCP_EXPOSABLE,
  MCP_METADATA_READ_CHANGES_STATE,
  MCP_STATEMENT_READ,
  OPENS_LOCAL_FILE,
  OPENS_SERVER_LEVEL_WITHOUT_DATABASE,
  READ_ROOTS_REQUIRED,
  READS_FILE_ACCESS_POSTURE,
  READS_TRUST_MATERIAL,
  REFUSES_DENIED_FILE_ACCESS,
  SHIPPED_DATABASE_TYPES,
  SINGLE_WRITER_FILE,
  SSH_TUNNEL_REFUSAL,
  WRITE_REACH,
} from "@/lib/db/compatibility";
import {
  AGENT_CREDENTIAL_FORM,
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
  seedOnlyProjectionRefusal,
  seedOnlyRefusal,
} from "@/lib/db/connection-fields";
import {
  CONNECTION_FORM,
  CONNECTION_PICKER_ORDER,
  type ConnectionFieldRule,
  type ConnectionFormSpec,
  offersSslPanel,
} from "@/lib/db/connection-form";
import { connectionFieldRefusal, connectionFieldShown } from "@/lib/db/connection-field-rules";
import {
  CONNECTION_STRING,
  CONNECTION_STRING_PASTE_ORDER,
  CONNECTION_STRING_PASTE_OVERLAPS,
  ENGINE_URI_SCHEMES,
} from "@/lib/db/connection-string";
import type { ConnectionStringPaste, ConnectionStringSpec } from "@/lib/db/connection-string/types";
import { CONFIRMATION_CLAIM_REVIEW, isReviewedConfirmationClaim } from "@/lib/db/confirmation-claim-review";
import { CREDENTIAL_WARNINGS, type CredentialWarning } from "@/lib/db/credential-warnings";
import { ENGINE_FACETS } from "@/lib/db/engine-facets";
import { MIGRATION_DDL, MIGRATION_DDL_FUNCTIONS, type MigrationDdlFunctions } from "@/lib/db/migration-ddl";
import type { CreateTableDdl, MigrationDdlSpec, TableDdlRefused, TableDdlWritten } from "@/lib/db/migration-ddl/types";
import { connectBudgetFor } from "@/lib/db/connect-budget";
import { EXECUTION_UI, executionUiFor } from "@/lib/db/execution-ui";
import type { ConsentDeadline, ExecutionUiSpec } from "@/lib/db/execution-ui/types";
import { createDatabaseProvider } from "@/lib/db/factory";
import { MONITORING_PANELS } from "@/lib/db/engine-facets/types";
import { CURATED_OPERATION_KINDS } from "@/lib/db/operations/descriptors";
import { refusedFieldRefusal } from "@/lib/db/provider-connection";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import { SQL_TEXT_REDACTION } from "@/lib/db/sql-grammar/redaction";
import type { CompletionQuoting, SqlGrammarSpec, SqlRedaction, UpdateTargetGrammar } from "@/lib/db/sql-grammar/types";
import { EDITOR_LANGUAGES, type EditorLanguage } from "@/lib/db/editor-language";
import type { EditorLanguageContribution } from "@/lib/db/editor-language/types";
import { SQL_ENGINE_GENERATORS, SQL_GENERATOR_FUNCTIONS, type SqlGeneratorFunctions } from "@/lib/db/query-generators";
import type { SqlEngineGenerators } from "@/lib/db/query-generators/types";
import { SQL_WRITING, SQL_WRITING_FUNCTIONS, type SqlWritingFunctions } from "@/lib/db/sql-writing";
import type { MetadataKind } from "@/lib/db/redaction/metadata-only";
import { summarizeWriteReach, WRITE_PATHS, type WriteReach } from "@/lib/db/write-reach";
import type {
  ExportSpec,
  ExportTypeVocabulary,
  InferredKind,
  InlineEditSpec,
  SqlWritingSpec,
} from "@/lib/db/sql-writing/types";
import { MONGODB_REDACTION_READER } from "@/lib/db/providers/document/mongodb/sql-grammar";
import { REDIS_REDACTION_READER } from "@/lib/db/providers/keyvalue/redis-sql-grammar";
import { POSTGRES_FORMAT_SEGMENT, POSTGRES_READ_QUOTED_QUALIFIER } from "@/lib/db/providers/sql/postgres-sql-grammar";
import { type DialectSpec, QUERY_DIALECTS, type QueryDialect } from "@/lib/db/query-dialects";
import { COUCHBASE_PASTE_READER } from "@/lib/db/providers/document/couchbase/connection-string";
import { MONGODB_PASTE_READER } from "@/lib/db/providers/document/mongodb/connection-string";
import { OPCUA_SEED_CHECK } from "@/lib/db/providers/industrial/opcua/connection-string";
import { ETCD_SEED_CHECK } from "@/lib/db/providers/keyvalue/etcd/connection-string";
import { REDIS_PASTE_READER } from "@/lib/db/providers/keyvalue/redis-connection-string";
import { CLICKHOUSE_PASTE_READER } from "@/lib/db/providers/sql/clickhouse/connection-string";
import { DATABEND_PASTE_READER } from "@/lib/db/providers/sql/databend/connection-string";
import { DB2_PASTE_READER, DB2_URL_TLS } from "@/lib/db/providers/sql/db2/connection-string";
import { LIBSQL_PASTE_READER } from "@/lib/db/providers/sql/libsql/connection-string";
import { MSSQL_PASTE_READER, MSSQL_URL_TLS } from "@/lib/db/providers/sql/mssql-connection-string";
import { MYSQL_PASTE_READER, MYSQL_URL_TLS } from "@/lib/db/providers/sql/mysql-connection-string";
import { ORACLE_PASTE_READER } from "@/lib/db/providers/sql/oracle-connection-string";
import { POSTGRES_PASTE_READER, POSTGRES_URL_TLS } from "@/lib/db/providers/sql/postgres-connection-string";
import {
  snowflakeAccountRefusal,
  snowflakeHostHint,
  snowflakeHostIdentity,
} from "@/lib/db/providers/sql/snowflake/account-host";
import { SNOWFLAKE_PASTE_READER, SNOWFLAKE_SEED_CHECK } from "@/lib/db/providers/sql/snowflake/connection-string";
import { SPARK_PASTE_READER } from "@/lib/db/providers/sql/spark/connection-string";
import {
  type AgentCredentialForm as ProviderAgentCredentialForm,
  declaredEntityOperations,
  type ExplainFormat,
  type MaintenanceOperation,
  type MaintenanceOperationSpec,
  maintenanceControl,
  type ProviderCapabilities,
  type WritePath,
  type WritePathReach,
} from "@/lib/db/types";
import { getExplainStrategy } from "@/lib/explain";
import { DIALECT_EDITORS, type DialectEditor } from "@/lib/editor/dialect-editors";
import { editorLanguageOf, resolveTabType } from "@/lib/editor/tab-language";
import { historyMaskOf } from "@/lib/history-mask";
import { type McpExposure, mcpStatementEngines } from "@/lib/mcp/tools/served-engines";
import type { NonFiniteWord } from "@/lib/non-finite";
import { importKubeconfig } from "@/lib/kubernetes/kubeconfig-import";
import { writesUnderGrammar } from "@/lib/sql/dangerous-query";
import { ALIAS_ENGINES, fenceTagEngine, isQueryFenceTag, QUERY_FENCE_ALIASES } from "@/lib/sql/fence-tags";
import { readOperativeKeyword } from "@/lib/sql/operative-keyword";
import { hasUnterminatedSpan, readSqlSpan } from "@/lib/sql/spans";
import { splitExecutionUnits } from "@/lib/sql/statement-splitter";
import { CONNECTION_FIELDS as FIELD_CLASSES } from "@/lib/storage/secret-fields";
import type { DatabaseConnection, DatabaseType, HostPathField, QueryTab } from "@/lib/types";
import { readCensusCapabilities } from "../../helpers/census-capabilities";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";
import { SPAN_STATEMENTS } from "./sql-grammar/fixtures";
import {
  DECLARED_SLOTS,
  type DeclaredSlotName,
  type SlotTable,
  slotFunction,
  slotNameAt,
  valueAt,
} from "./engine-declarations/declared-slots";

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

/** The authored members of one type-id's committed declaration, the generator's source for them. */
function authored(type: DatabaseType): AuthoredMembers {
  return authoredMembersOf(declared(type), `${type}.json`);
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

/** A row's redaction as a declaration writes it: a command reader named by its slot. */
function declaredRedaction(row: SqlRedaction): object {
  if (row.kind === "sql") return { kind: "sql", nameQuote: row.nameQuote };
  return row.kind === "command" ? { kind: "command", reader: "redactionReader" } : { kind: "none" };
}

/** The reader of a command redaction, or undefined where the redaction is of another kind. */
function commandReader(redaction: SqlRedaction): unknown {
  return redaction.kind === "command" ? redaction.read : undefined;
}

/**
 * The census's own resolver of the functions a declaration names: per engine, each name mapped to the function Studio
 * exports, imported here from its own module. It is written apart from the generator and the inventory, so a name is
 * held to the function the connection form runs by identity, and never by a function's `name`.
 *
 * A connection string name resolves to the export of the engine's own connection string module, `<ID>_URL_TLS`,
 * `<ID>_PASTE_READER` or `<ID>_SEED_CHECK`, imported from its provider module rather than from the registry index:
 * `CONNECTION_STRING_FUNCTIONS` binds each name to one of them, and the census holds each composed row's functions to
 * the export its declaration's name resolves to here.
 * A SQL grammar name resolves the same way, to the slot of the engine's own grammar row imported from its provider
 * module: every redaction reader and completion reader is private to its module too.
 */
const NAMED_FUNCTIONS: Readonly<Partial<Record<DatabaseType, Readonly<Record<string, unknown>>>>> = {
  snowflake: {
    hostCheck: snowflakeAccountRefusal,
    hostHint: snowflakeHostHint,
    hostIdentity: snowflakeHostIdentity,
    pasteReader: SNOWFLAKE_PASTE_READER,
    seedCheck: SNOWFLAKE_SEED_CHECK,
  },
  kubernetes: { importer: importKubeconfig },
  clickhouse: { pasteReader: CLICKHOUSE_PASTE_READER },
  couchbase: { pasteReader: COUCHBASE_PASTE_READER },
  databend: { pasteReader: DATABEND_PASTE_READER },
  db2: { urlTls: DB2_URL_TLS, pasteReader: DB2_PASTE_READER },
  etcd: { seedCheck: ETCD_SEED_CHECK },
  libsql: { pasteReader: LIBSQL_PASTE_READER },
  mongodb: {
    pasteReader: MONGODB_PASTE_READER,
    redactionReader: MONGODB_REDACTION_READER,
  },
  mssql: { urlTls: MSSQL_URL_TLS, pasteReader: MSSQL_PASTE_READER },
  mysql: { urlTls: MYSQL_URL_TLS, pasteReader: MYSQL_PASTE_READER },
  opcua: { seedCheck: OPCUA_SEED_CHECK },
  oracle: { pasteReader: ORACLE_PASTE_READER },
  postgres: {
    urlTls: POSTGRES_URL_TLS,
    pasteReader: POSTGRES_PASTE_READER,
    formatSegment: POSTGRES_FORMAT_SEGMENT,
    readQuotedQualifier: POSTGRES_READ_QUOTED_QUALIFIER,
  },
  redis: { pasteReader: REDIS_PASTE_READER, redactionReader: REDIS_REDACTION_READER },
  spark: { pasteReader: SPARK_PASTE_READER },
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

/** The registry's SQL generator row of `type`, read as an own key; undefined where the engine writes the shared forms. */
function sqlGeneratorRow(type: DatabaseType): SqlEngineGenerators | undefined {
  return Object.hasOwn(SQL_ENGINE_GENERATORS, type) ? SQL_ENGINE_GENERATORS[type] : undefined;
}

/** The shipped engines that speak a statement language, each with the family its `AGENT_STATEMENT_LANGUAGE` row names. */
const LANGUAGE_ENGINES: readonly (readonly [DatabaseType, AgentStatementLanguageId])[] = SHIPPED_DATABASE_TYPES.flatMap(
  (type) => {
    const family = AGENT_STATEMENT_LANGUAGE[type];
    return family === null ? [] : [[type, family] as const];
  },
);

/**
 * Each engine's agent server overlay as its own module exports it, the module found by the agent leg's triad path
 * (`src/lib/agent/languages/<family>/engines/<type-id>.ts`, the rule tests/unit/lib/agent/engine-docs.test.ts reads) and
 * imported by its absolute path, never through the registry the generator reads: every agent overlay slot the census's
 * slot table names is resolved on this overlay. Only the engines that speak a statement language have one.
 */
const MODULE_AGENT_OVERLAYS: ReadonlyMap<DatabaseType, unknown> = new Map(
  await Promise.all(
    LANGUAGE_ENGINES.map(
      async ([type, family]) =>
        [
          type,
          (
            (await import(path.join(ROOT, `src/lib/agent/languages/${family}/engines/${type}.ts`))) as Record<
              string,
              unknown
            >
          )[`${type.toUpperCase()}_SERVER_OVERLAY`],
        ] as const,
    ),
  ),
);

/** The engine module's agent server overlay of `type`, which the census holds to be the registry's overlay. */
function moduleAgentOverlay(type: DatabaseType): object {
  const overlay = MODULE_AGENT_OVERLAYS.get(type);
  if (typeof overlay !== "object" || overlay === null) throw new Error(`${type}: no agent overlay module exports one`);
  return overlay;
}

/**
 * The row of `table` that `type`'s own engine module exports, on which the census resolves that table's slots; undefined
 * only for an SQL generator row the engine does not have and for the agent overlay of an engine that speaks no
 * statement language, since every shipped engine has a row of the other two tables.
 */
function moduleRow(table: SlotTable, type: DatabaseType): object | undefined {
  const rows: Readonly<Record<SlotTable, () => object | undefined>> = {
    SQL_WRITING: () => SQL_WRITING[type],
    MIGRATION_DDL: () => MIGRATION_DDL[type],
    SQL_ENGINE_GENERATORS: () => sqlGeneratorRow(type),
    AGENT_SERVER_OVERLAY: () => (MODULE_AGENT_OVERLAYS.has(type) ? moduleAgentOverlay(type) : undefined),
  };
  return rows[table]();
}

/** The kinds a bare type family may be, in the order of the schema's `typeFamilies`. */
const TYPE_FAMILY_KINDS = Object.keys(SCHEMA.$defs.typeFamilies?.properties ?? {}) as InferredKind[];

/**
 * The dotted path of every member the schema's `$defs/<name>` states as a function name, a member that refers to a
 * definition with members of its own followed into it, so the census finds every name a declaration states from the
 * schema itself.
 */
function schemaFunctionPaths(name: string, at = ""): string[] {
  const definition = SCHEMA.$defs[name] as SchemaMember | undefined;
  const refsOf = (schemas: readonly SchemaMember[]) =>
    schemas.flatMap((branch) => (branch.$ref === undefined ? [] : [branch.$ref.replace("#/$defs/", "")]));
  const members = Object.entries(definition?.properties ?? {}).flatMap(([member, schema]) => {
    const path = at === "" ? member : `${at}.${member}`;
    const refs = refsOf([schema, ...(schema.oneOf ?? [])]);
    if (refs.includes("functionName")) return [path];
    return refs.flatMap((ref) => schemaFunctionPaths(ref, path));
  });
  // A definition that is itself a union, such as migrationDdl or createTable, states its members in its branches, at
  // the definition's own path.
  const variants = refsOf(definition?.oneOf ?? []).flatMap((ref) => schemaFunctionPaths(ref, at));
  return [...members, ...variants];
}

/** A schema definition or a member of one, as far as `schemaFunctionPaths` reads it. */
interface SchemaMember {
  readonly $ref?: string;
  readonly oneOf?: readonly SchemaMember[];
  readonly properties?: Readonly<Record<string, SchemaMember>>;
}

/** The function members of a declaration's `sqlWriting`, by their dotted paths, read off the schema. */
const SQL_WRITING_FUNCTION_PATHS = schemaFunctionPaths("sqlWriting");

/** The slot kind of Studio's SQL writing function table that binds the name a declaration states at each path. */
const SQL_WRITING_SLOT_KINDS: Readonly<Record<string, keyof SqlWritingFunctions>> = {
  escapeLiteral: "escapeLiterals",
  unescapeLiteral: "unescapeLiterals",
  quoteIdentifier: "quoteIdentifiers",
  placeholder: "placeholders",
  temporalLiteral: "temporalLiterals",
  insertDocuments: "insertDocuments",
  "inlineEdit.boundEdit": "boundEdits",
  "export.binaryLiteral": "binaryLiterals",
  "export.rewriteDeclared": "rewriteDeclareds",
  "export.declareFromSample": "declareFromSamples",
  "export.typedLiteral": "typedLiterals",
  "export.columnWriters": "columnWriters",
  "export.createTableKey.clause": "createTableKeyClauses",
};

/** The function members of a declaration's `migrationDdl`, in either form, by their dotted paths, read off the schema. */
const MIGRATION_DDL_FUNCTION_PATHS = schemaFunctionPaths("migrationDdl");

/** The slot kind of Studio's migration DDL function table that binds the name a declaration states at each path. */
const MIGRATION_DDL_SLOT_KINDS: Readonly<Record<string, keyof MigrationDdlFunctions>> = {
  "createTable.primaryKey": "createTablePrimaryKeys",
  "createTable.foreignKey": "createTableForeignKeys",
  "createTable.createTableRefusal": "createTableRefusals",
  columnDef: "columnDefs",
  createIndex: "createIndexes",
  dropIndex: "dropIndexes",
  addForeignKey: "addForeignKeys",
  dropForeignKey: "dropForeignKeys",
  addColumn: "addColumns",
  dropColumn: "dropColumns",
  modifyColumn: "modifyColumns",
  dropTable: "dropTables",
};

/** Every function name a declaration's `migrationDdl` states, with the dotted path it is stated at. */
function migrationDdlNames(d: EngineDeclaration): (readonly [path: string, name: string])[] {
  return MIGRATION_DDL_FUNCTION_PATHS.flatMap((path) => {
    const name = valueAt(d.migrationDdl, path);
    return typeof name === "string" ? [[path, name] as const] : [];
  });
}

/** The function members of a declaration's `sqlGenerators`, by their dotted paths, read off the schema. */
const SQL_GENERATORS_FUNCTION_PATHS = schemaFunctionPaths("sqlGenerators");

/** The slot kind of Studio's SQL generator function table that binds the name a declaration states at each path. */
const SQL_GENERATOR_SLOT_KINDS: Readonly<Record<string, keyof SqlGeneratorFunctions>> = {
  quote: "quotes",
  table: "tables",
  select: "selects",
  selectList: "selectLists",
};

/** Every function name a declaration's `sqlGenerators` states, with the dotted path it is stated at; none where null. */
function sqlGeneratorNames(d: EngineDeclaration): (readonly [path: string, name: string])[] {
  return SQL_GENERATORS_FUNCTION_PATHS.flatMap((path) => {
    const name = valueAt(d.sqlGenerators, path);
    return typeof name === "string" ? [[path, name] as const] : [];
  });
}

/** The function members of a declaration's `agent.overlay`, by their dotted paths, read off the schema. */
const AGENT_OVERLAY_FUNCTION_PATHS = schemaFunctionPaths("agentOverlay");

/** Every function name a declaration's `agent.overlay` states, with the dotted path it is stated at; none where null. */
function agentOverlayNames(d: EngineDeclaration): (readonly [path: string, name: string])[] {
  return AGENT_OVERLAY_FUNCTION_PATHS.flatMap((path) => {
    const name = valueAt(d.agent.overlay, path);
    return typeof name === "string" ? [[path, name] as const] : [];
  });
}

/**
 * The members of Studio's SQL server dialect, written here apart from the generator and typed so a member Studio adds
 * or removes fails to compile until the census lists it.
 */
const SQL_SERVER_DIALECT_MEMBERS: Readonly<Record<keyof SqlServerDialect, true>> = {
  catalogRead: true,
  planEstimate: true,
  profileComposition: true,
  statistics: true,
  catalogCapture: true,
};

/**
 * The data members of a server dialect in the declaration's form, written here from Studio's overlay types rather than
 * from the generator: each member null where the dialect says `"unsupported"`, the command flag as `=== true`, each
 * type pattern by its source and flags, a probe or note the reading leaves out null, the capture's kinds in order and
 * its kind words as the record's entries in key order. The functions are left out: the slot tests hold them.
 */
function dialectData(dialect: AgentEngineServerDialect): unknown {
  const { catalogRead, planEstimate, profileComposition, statistics, catalogCapture } = dialect;
  const pattern = (value: RegExp) => ({ source: value.source, flags: value.flags });
  return {
    catalogRead: catalogRead === "unsupported" ? null : { commandShaped: catalogRead.commandShaped === true },
    planEstimate: planEstimate === "unsupported" ? null : { ...planEstimate },
    profileComposition:
      profileComposition === "unsupported"
        ? null
        : {
            incomparableType: pattern(profileComposition.incomparableType),
            uncountableType:
              profileComposition.uncountableType === undefined ? null : pattern(profileComposition.uncountableType),
          },
    statistics:
      statistics === "unsupported" ? null : { probe: statistics.probe, limitNote: statistics.limitNote ?? null },
    catalogCapture:
      catalogCapture === "unsupported"
        ? null
        : {
            kinds: [...catalogCapture.kinds],
            kindWords: Object.entries(catalogCapture.kindWords).map(([word, kind]) => ({ word, kind })),
          },
  };
}

/** The data members a declaration's SQL dialect states, in the form `dialectData` writes, its function names left out. */
function declaredDialectData(dialect: NonNullable<SqlDialect>): unknown {
  const { catalogRead, planEstimate, profileComposition, statistics, catalogCapture } = dialect;
  return {
    catalogRead: catalogRead === null ? null : { commandShaped: catalogRead.commandShaped },
    planEstimate,
    profileComposition:
      profileComposition === null
        ? null
        : {
            incomparableType: profileComposition.incomparableType,
            uncountableType: profileComposition.uncountableType,
          },
    statistics: statistics === null ? null : { probe: statistics.probe, limitNote: statistics.limitNote },
    catalogCapture:
      catalogCapture === null ? null : { kinds: catalogCapture.kinds, kindWords: catalogCapture.kindWords },
  };
}

/** The client view of a declared SQL dialect: each member the client asks about supported exactly where it is stated. */
function clientViewOf(dialect: NonNullable<SqlDialect>): unknown {
  const supported = (member: unknown) => (member === null ? "unsupported" : "supported");
  return {
    catalogRead: supported(dialect.catalogRead),
    planEstimate: supported(dialect.planEstimate),
    catalogCapture: supported(dialect.catalogCapture),
  };
}

/** The dotted paths of the slots of `table` in the census's slot table. */
function tablePaths(table: SlotTable): string[] {
  return Object.values(DECLARED_SLOTS)
    .filter((slot) => slot.table === table)
    .map(({ path }) => path);
}

/** Every function name a declaration's `sqlWriting` states, with the dotted path it is stated at. */
function sqlWritingNames(d: EngineDeclaration): (readonly [path: string, name: string])[] {
  return SQL_WRITING_FUNCTION_PATHS.flatMap((path) => {
    const name = valueAt(d.sqlWriting, path);
    return typeof name === "string" ? [[path, name] as const] : [];
  });
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
 * that names it, its tab named by the dialect, and every member as written, a history mask null where it has none. A second
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
      historyMask: row.historyMask === null ? null : { credentialFlags: [...row.historyMask.credentialFlags] },
    };
    const earlier = table[row.name];
    if (earlier !== undefined && !sameValue(earlier, spec)) {
      throw new Error(`${type}: the ${row.name} dialect's row differs from an earlier declaration's`);
    }
    table[row.name] = spec;
  }
  return table as Record<QueryDialect, DialectSpec>;
}

/**
 * The tab type a dialect-less engine's tabs open under, keyed by its query language (docs/providers/CONTRACT.md,
 * clause S-23), written here from the contract rather than read from `resolveTabType`, so the census holds that ladder
 * to it.
 */
const LANGUAGE_TAB_TYPES: Readonly<Record<QueryLanguage, QueryTab["type"]>> = {
  sql: "sql",
  json: "mongodb",
  promql: "promql",
  cypher: "cypher",
  influxql: "influxql",
};

/** The tab type a declaration's engine opens its tabs under: its dialect's name, or its query language's tab type. */
function declaredTabType(d: EngineDeclaration): QueryTab["type"] {
  return d.editor.dialect === null ? LANGUAGE_TAB_TYPES[d.editor.language.queryLanguage] : d.editor.dialect.name;
}

/**
 * The editor language facts the declarations state, one entry per Monaco language and one per tab type: two
 * declarations stating one language with a different accent or console, or one tab type in a different language, are a
 * thrown error naming both engines.
 */
function derivedEditorLanguages(): {
  languages: Record<string, { accent: string; console: boolean; engine: DatabaseType }>;
  tabTypes: Record<string, { monacoId: string; engine: DatabaseType }>;
} {
  const languages: Record<string, { accent: string; console: boolean; engine: DatabaseType }> = {};
  const tabTypes: Record<string, { monacoId: string; engine: DatabaseType }> = {};
  for (const type of SHIPPED_DATABASE_TYPES) {
    const d = declared(type);
    const { monacoId, accent, console } = d.editor.language;
    const language = languages[monacoId];
    if (language !== undefined && (language.accent !== accent || language.console !== console)) {
      throw new Error(`${type} states the ${monacoId} editor language unlike ${language.engine}`);
    }
    languages[monacoId] ??= { accent, console, engine: type };
    const tabType = declaredTabType(d);
    const editor = tabTypes[tabType];
    if (editor !== undefined && editor.monacoId !== monacoId) {
      throw new Error(`${type} states the ${tabType} tab type's language unlike ${editor.engine}`);
    }
    tabTypes[tabType] ??= { monacoId, engine: type };
  }
  return { languages, tabTypes };
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

  test("each declaration is what the generator builds from its authored members and Studio's tables", async () => {
    const capabilities = await readEngineCapabilities();
    const stale = SHIPPED_DATABASE_TYPES.filter(
      (type) =>
        readFileSync(path.join(DIRECTORY, `${type}.json`), "utf8") !==
        renderEngineDeclaration(buildEngineDeclaration(type, capabilities[type], authored(type))),
    ).map((type) => `${ENGINE_DECLARATIONS_DIRECTORY}/${type}.json differs: run bun run engines:generate`);

    expect(stale).toEqual([]);
  });

  test("the authored members are the catalog's, the data-only connection members and connection claims, the facets' agent readings, the agent's statement language, the connection form's, the connection string's, the editor's commit keyword, consent deadline, fence aliases, dialect and language, the SQL text's members but its redaction, the SQL writing, migration DDL and SQL generator segments, and the policy, MCP and safeguards segments", () => {
    expect([...AUTHORED_MEMBERS]).toEqual([
      "id",
      "displayName",
      "location",
      "connection.fields",
      "connection.defaults",
      "connection.seedOnly",
      "connection.refused",
      "connection.connectionString.accepted",
      "connection.connectionString.dialogOffersUri",
      "connection.connectionString.scheme",
      "connection.connectionString.urlTls",
      "connection.connectionString.paste",
      "connection.connectionString.seedCheck",
      "connection.tls",
      "connection.readsTrustMaterial",
      "connection.dialog",
      "connection.hostUriSchemes",
      "connection.credentialWarnings",
      "connection.fieldRules",
      "connection.hostHint",
      "connection.hostIdentity",
      "connection.import",
      "connection.connectBudgetMs",
      "connection.sshTunnel",
      "connection.hostPathFields",
      "connection.opensLocalFile",
      "connection.serverLevelWithoutDatabase",
      "connection.agentCredential",
      "facets.agentReadings",
      "agent.statementLanguage",
      "editor.commitKeyword",
      "editor.consentDeadline",
      "editor.fenceAliases",
      "editor.dialect",
      "editor.language",
      "sqlText.readsSqlText",
      "sqlText.grammar",
      "sqlText.updateTarget",
      "sqlText.completion",
      "sqlWriting",
      "migrationDdl",
      "sqlGenerators",
      "policy",
      "mcp",
      "safeguards",
    ]);
    const bigquery = declared("bigquery");
    expect(authored("bigquery")).toEqual({
      id: "bigquery",
      displayName: "BigQuery",
      location: "external",
      connection: {
        fields: bigquery.connection.fields,
        defaults: {},
        seedOnly: null,
        refused: [],
        connectionString: {
          accepted: false,
          dialogOffersUri: false,
          scheme: null,
          urlTls: null,
          paste: null,
          seedCheck: null,
        },
        tls: { modes: [] },
        readsTrustMaterial: false,
        sshTunnel: bigquery.connection.sshTunnel,
        hostPathFields: [],
        opensLocalFile: false,
        serverLevelWithoutDatabase: false,
        agentCredential: { form: "secret", supersededBy: [] },
        dialog: bigquery.connection.dialog,
        hostUriSchemes: [],
        credentialWarnings: [],
        fieldRules: [],
        hostHint: null,
        hostIdentity: null,
        import: null,
        connectBudgetMs: 140_000,
      },
      facets: { agentReadings: ["sessions", "slow-queries", "table-stats", "storage", "health"] },
      agent: { statementLanguage: null },
      editor: {
        commitKeyword: "COMMIT",
        consentDeadline: null,
        fenceAliases: [],
        dialect: null,
        language: { queryLanguage: "sql", monacoId: "sql", accent: "border-hue-blue/40", console: false },
      },
      sqlText: {
        readsSqlText: true,
        grammar: bigquery.sqlText.grammar,
        updateTarget: bigquery.sqlText.updateTarget,
        completion: { formatSegment: null, readQuotedQualifier: null },
      },
      sqlWriting: bigquery.sqlWriting,
      migrationDdl: bigquery.migrationDdl,
      sqlGenerators: null,
      policy: {
        writeReach: "open",
        readsFileAccessPosture: false,
        deniedFileAccessRefusal: null,
        singleWriterFile: false,
        readRootsRequired: false,
        agentCredentialForm: "service-account-key",
        maskingExemptColumns: null,
      },
      mcp: bigquery.mcp,
      safeguards: bigquery.safeguards,
    });
    // The policy and MCP segments are claims an engine requests, authored with the safeguards, the evidence its write
    // reach request summarizes; every gate reads Studio's grant of each claim, never the request.
    expect(authored("etcd").policy.writeReach).toBe("guarded");
    expect(authored("etcd").safeguards).toEqual(declared("etcd").safeguards);
    expect(authored("s3").mcp.agentCredentialRequired).toBe(true);
    // The connection claims are requests an engine states in its declaration: every connection gate reads Studio's
    // grant of each, never the request.
    expect(bigquery.connection.sshTunnel.offered).toBe(false);
    expect(authored("postgres").connection.sshTunnel).toEqual({ offered: true });
    expect(authored("postgres").connection.serverLevelWithoutDatabase).toBe(true);
    expect(authored("sqlite").connection.opensLocalFile).toBe(true);
    expect(authored("opcua").connection.hostPathFields).toEqual(["clientCertificatePath", "clientPrivateKeyPath"]);
    expect(authored("elasticsearch").connection.agentCredential).toEqual({
      form: "pair",
      supersededBy: ["apiKeyId", "apiKeySecret"],
    });
    expect(authored("libredb").connection.agentCredential).toBeNull();
    // The facets' agent readings and the agent's statement language are requests too: agent mode reads Studio's grant
    // of each, never the request. The rest of both segments is generated.
    expect(authored("kafka").facets).toEqual({ agentReadings: ["health"] });
    expect(authored("kafka").agent).toEqual({ statementLanguage: "kafkaread" });
    expect(authored("mqtt").facets.agentReadings).toEqual([]);
    // The SQL writing segment holds no claim, so the whole segment is authored.
    expect(authored("cassandra").sqlWriting).toEqual(declared("cassandra").sqlWriting);
    // The redaction is a claim, so it is no authored member: the generator writes it from Studio's record.
    expect(Object.keys(authored("mongodb").sqlText)).toEqual(["readsSqlText", "grammar", "updateTarget", "completion"]);
    expect(authored("postgres").sqlText.completion).toEqual({
      formatSegment: "formatSegment",
      readQuotedQualifier: "readQuotedQualifier",
    });
    expect(authored("snowflake").connection.fieldRules).toEqual(declared("snowflake").connection.fieldRules);
    expect(authored("snowflake").connection.hostHint).toBe("hostHint");
    expect(authored("kubernetes").connection.import).toEqual({ label: "Import kubeconfig", importer: "importer" });
    expect(authored("kubernetes").connection.hostUriSchemes).toEqual(["https", "http"]);
    expect(authored("postgres").connection.defaults).toEqual({ port: 5432 });
    expect(authored("libredb").location).toBe("embedded");
    expect(authored("libredb").connection.connectBudgetMs).toBeNull();
    expect(authored("opcua").connection.seedOnly).toEqual(declared("opcua").connection.seedOnly);
    expect(authored("rabbitmq").connection.refused).toEqual(declared("rabbitmq").connection.refused);
    expect(authored("s3").connection.credentialWarnings).toEqual(declared("s3").connection.credentialWarnings);
    expect(authored("db2").connection.readsTrustMaterial).toBe(true);
    expect(authored("mongodb").connection.connectionString).toEqual({
      accepted: true,
      dialogOffersUri: true,
      scheme: "mongodb",
      urlTls: null,
      paste: { reader: "pasteReader", catchAll: false, formats: ["mongodb://"] },
      seedCheck: null,
    });
    expect(authored("snowflake").connection.connectionString).toEqual(
      declared("snowflake").connection.connectionString,
    );
    expect(authored("db2").connection.connectionString.urlTls).toBe("urlTls");
    expect(authored("etcd").connection.connectionString.seedCheck).toBe("seedCheck");
    expect(authored("redis").editor.commitKeyword).toBe("EXEC");
    expect(authored("sqlite").editor.consentDeadline).toEqual(declared("sqlite").editor.consentDeadline);
    expect(authored("postgres").editor.fenceAliases).toEqual(["postgresql", "pgsql", "psql", "plpgsql"]);
    expect(authored("kubernetes").editor.dialect).toEqual(declared("kubernetes").editor.dialect);
    expect(authored("kubernetes").editor.dialect?.historyMask?.credentialFlags).toContain("--token");
    expect(authored("milvus").editor.language).toEqual({
      queryLanguage: "json",
      monacoId: "milvus",
      accent: "border-hue-teal/40",
      console: true,
    });
  });

  test("a declaration's authored members are its committed file's, and every other member is the tables'", () => {
    // A hand edit of an authored member is kept and a hand edit of a generated one is rewritten from the tables.
    const committed = declared("postgres");
    const refused = [...committed.connection.refused, { field: "schema" as const, refusal: "Edited by hand." }];
    const connection = {
      ...committed.connection,
      refused,
      readsTrustMaterial: true,
      connectionString: {
        ...committed.connection.connectionString,
        dialogOffersUri: true,
        paste: { reader: "pasteReader", catchAll: false, formats: ["postgres://", "Edited by hand"] },
      },
      connectBudgetMs: 90_000,
      defaults: { port: 6543 },
      tls: { modes: [] },
      dialog: { ...committed.connection.dialog, labels: [{ field: "host" as const, text: "Edited by hand" }] },
      hostUriSchemes: ["https" as const],
      fieldRules: [{ field: "user" as const, required: "Edited by hand.", format: null, charRange: null, check: null }],
      hostHint: "hostHint",
      hostIdentity: "hostIdentity",
      import: { label: "Edited by hand", importer: "importer" },
      // The connection claims are authored: a request edited by hand is kept, whatever Studio's records say, and only
      // Studio's grant of it reaches a gate.
      sshTunnel: { offered: false as const, refusal: "Edited by hand." },
      hostPathFields: ["clientCertificatePath" as const],
      opensLocalFile: true,
      serverLevelWithoutDatabase: false,
      agentCredential: null,
    };
    const editor = {
      ...committed.editor,
      commitKeyword: "APPLY",
      consentDeadline: { chip: "Edited by hand", sentence: "Edited by hand." },
      fenceAliases: ["pgedited"],
      language: { ...committed.editor.language, accent: "border-hue-orange/40" },
    };
    const sqlText = {
      ...committed.sqlText,
      grammar: { ...committed.sqlText.grammar, nonNumericRowBounds: ["ALL", "NONE"] },
      updateTarget: { ...committed.sqlText.updateTarget, extraQueryOpeners: ["RETURNING"] },
    };
    const sqlWriting = {
      ...committed.sqlWriting,
      export: { ...committed.sqlWriting.export, ddlTypes: { ...committed.sqlWriting.export.ddlTypes, text: "CLOB" } },
    };
    // The policy, MCP and safeguards segments are authored: a request edited by hand is kept, whatever Studio's records
    // and the provider's capabilities say, and only Studio's grant of it reaches a gate.
    const absent = { reach: "absent" as const, proof: null };
    const policy = { ...committed.policy, writeReach: "none" as const, readRootsRequired: true };
    const mcp = { ...committed.mcp, statementRead: false };
    const safeguards = {
      ...committed.safeguards,
      writePaths: { editor: absent, objectEdit: absent, maintenance: absent, transaction: absent },
    };
    // The facets' agent readings and the agent's statement language are authored: a request edited by hand is kept,
    // and the rest of both segments is rewritten from Studio's tables.
    const facets = { ...committed.facets, agentReadings: ["health" as const] };
    const agent = { ...committed.agent, statementLanguage: "mongo" as const };
    const edited = {
      ...committed,
      displayName: "Edited by hand",
      location: "embedded",
      connection,
      facets: { ...facets, maintenance: [] },
      agent: { ...agent, overlay: null },
      editor: { ...editor, explainFormat: null },
      sqlText: { ...sqlText, redaction: { kind: "none" } },
      sqlWriting,
      policy,
      mcp,
      safeguards,
    };
    const built = buildEngineDeclaration("postgres", CAPABILITIES.postgres, authoredMembersOf(edited, "postgres.json"));

    // The SQL text's authored members are kept, and its redaction, a claim, is rewritten from Studio's record; the SQL
    // writing segment and the policy, MCP and safeguards segments are kept as edited.
    expect(built).toEqual({
      ...committed,
      displayName: "Edited by hand",
      location: "embedded",
      connection,
      facets,
      agent,
      editor,
      sqlText,
      sqlWriting,
      policy,
      mcp,
      safeguards,
    });
    // The editor's authored members come from the declaration alone: the generator reads no execution UI, fence, dialect
    // or editor language table, so a dialect row or an accent edited by hand is kept.
    const kafka = declared("kafka");
    const kafkaDialect = kafka.editor.dialect as NonNullable<EngineDeclaration["editor"]["dialect"]>;
    const counting = { ...kafka, editor: { ...kafka.editor, dialect: { ...kafkaDialect, offersCountQuery: true } } };
    expect(
      buildEngineDeclaration("kafka", CAPABILITIES.kafka, authoredMembersOf(counting, "kafka.json")).editor.dialect,
    ).toEqual({ ...kafkaDialect, offersCountQuery: true });
    expect(built.connection.sshTunnel).toEqual({ offered: false, refusal: "Edited by hand." });
    expect(built.editor.explainFormat).toEqual(committed.editor.explainFormat);
    expect(() =>
      buildEngineDeclaration("postgres", CAPABILITIES.postgres, { ...authored("postgres"), id: "mysql" }),
    ).toThrow('postgres: the authored members given name the engine id "mysql"');
  });

  test("a committed declaration lacking an authored member, or naming another id than its file, is refused by name", () => {
    const committed = declared("bigquery");
    const without = (value: object, member: string) =>
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== member));
    const withoutLocation = without(committed, "location");

    expect(() => authoredMembersOf({ ...committed, id: undefined }, "bigquery.json")).toThrow(
      "bigquery.json lacks its authored member id",
    );
    expect(() => authoredMembersOf(withoutLocation, "bigquery.json")).toThrow(
      "bigquery.json lacks its authored member location",
    );
    expect(() => authoredMembersOf(without(committed, "displayName"), "bigquery.json")).toThrow(
      "bigquery.json lacks its authored member displayName",
    );
    for (const member of [
      "fields",
      "defaults",
      "seedOnly",
      "refused",
      "tls",
      "readsTrustMaterial",
      "dialog",
      "hostUriSchemes",
      "credentialWarnings",
      "fieldRules",
      "hostHint",
      "hostIdentity",
      "import",
      "connectBudgetMs",
    ] as const) {
      expect(() =>
        authoredMembersOf({ ...committed, connection: without(committed.connection, member) }, "bigquery.json"),
      ).toThrow(`bigquery.json lacks its authored member connection.${member}`);
    }
    for (const member of ["accepted", "dialogOffersUri", "scheme", "urlTls", "paste", "seedCheck"] as const) {
      const connectionString = without(committed.connection.connectionString, member);
      expect(() =>
        authoredMembersOf({ ...committed, connection: { ...committed.connection, connectionString } }, "bigquery.json"),
      ).toThrow(`bigquery.json lacks its authored member connection.connectionString.${member}`);
    }
    expect(() =>
      authoredMembersOf(
        { ...committed, connection: { ...committed.connection, connectionString: null } },
        "bigquery.json",
      ),
    ).toThrow("bigquery.json lacks its authored member connection.connectionString.accepted");
    for (const member of ["commitKeyword", "consentDeadline", "fenceAliases", "dialect", "language"] as const) {
      expect(() =>
        authoredMembersOf({ ...committed, editor: without(committed.editor, member) }, "bigquery.json"),
      ).toThrow(`bigquery.json lacks its authored member editor.${member}`);
    }
    expect(() =>
      authoredMembersOf({ ...committed, facets: without(committed.facets, "agentReadings") }, "bigquery.json"),
    ).toThrow("bigquery.json lacks its authored member facets.agentReadings");
    expect(() =>
      authoredMembersOf({ ...committed, agent: without(committed.agent, "statementLanguage") }, "bigquery.json"),
    ).toThrow("bigquery.json lacks its authored member agent.statementLanguage");
    // A statement language stated as null is stated: an engine that speaks none authors null.
    expect(authoredMembersOf(committed, "bigquery.json").agent.statementLanguage).toBeNull();
    expect(() => authoredMembersOf(without(committed, "editor"), "bigquery.json")).toThrow(
      "bigquery.json lacks its authored member editor.commitKeyword",
    );
    for (const member of ["readsSqlText", "grammar", "updateTarget", "completion"] as const) {
      expect(() =>
        authoredMembersOf({ ...committed, sqlText: without(committed.sqlText, member) }, "bigquery.json"),
      ).toThrow(`bigquery.json lacks its authored member sqlText.${member}`);
    }
    expect(() => authoredMembersOf(without(committed, "sqlWriting"), "bigquery.json")).toThrow(
      "bigquery.json lacks its authored member sqlWriting",
    );
    expect(() => authoredMembersOf(without(committed, "migrationDdl"), "bigquery.json")).toThrow(
      "bigquery.json lacks its authored member migrationDdl",
    );
    expect(() => authoredMembersOf(without(declared("postgres"), "migrationDdl"), "postgres.json")).toThrow(
      "postgres.json lacks its authored member migrationDdl",
    );
    expect(() => authoredMembersOf(without(committed, "sqlGenerators"), "bigquery.json")).toThrow(
      "bigquery.json lacks its authored member sqlGenerators",
    );
    for (const member of ["policy", "mcp", "safeguards"] as const) {
      expect(() => authoredMembersOf(without(committed, member), "bigquery.json")).toThrow(
        `bigquery.json lacks its authored member ${member}`,
      );
    }
    // A segment stated as null is stated: an engine that writes the shared forms authors null.
    expect(authoredMembersOf(declared("postgres"), "postgres.json").sqlGenerators).toBeNull();
    // A declaration lacking its redaction is no authored member short: the generator writes it from Studio's record.
    expect(() =>
      authoredMembersOf({ ...committed, sqlText: without(committed.sqlText, "redaction") }, "bigquery.json"),
    ).not.toThrow();
    for (const value of [null, [], "bigquery", { ...committed, connection: null }]) {
      expect(() => authoredMembersOf(value, "bigquery.json")).toThrow("bigquery.json lacks its authored member");
    }
    expect(() => authoredMembersOf(committed, "snowflake.json")).toThrow(
      'snowflake.json names the engine id "bigquery", not its file name',
    );
  });

  test("each declaration is admitted by the schema's engine declaration and its rules", () => {
    const validator = compileManifestValidator(readFileSync(SCHEMA_FILE));
    const refused = SHIPPED_DATABASE_TYPES.filter((type) => !validator.validateEngine(declared(type)).admitted);

    expect(refused).toEqual([]);
  });

  test("the generator refuses, by name, an explain format the provider's explain support contradicts", () => {
    const unformatted: ProviderCapabilities = { ...CAPABILITIES.postgres, explainFormat: undefined };
    const unsupported: ProviderCapabilities = {
      ...CAPABILITIES.kafka,
      supportsExplain: false,
      explainFormat: "postgres-json",
    };

    expect(() => buildEditor("postgres", unformatted, authored("postgres").editor)).toThrow(
      "postgres: the provider supports explain but declares no explain format",
    );
    expect(() => buildEditor("kafka", unsupported, authored("kafka").editor)).toThrow(
      "kafka: the provider declares an explain format but supports no explain",
    );
  });

  test("the generator refuses, by name, a declaration whose query dialect or query language is not the one its provider declares", () => {
    const kafka = authored("kafka").editor;
    const postgres = authored("postgres").editor;
    const redis = authored("redis").editor.dialect;

    expect(() => buildEditor("kafka", CAPABILITIES.kafka, kafka)).not.toThrow();
    expect(() => buildEditor("postgres", CAPABILITIES.postgres, postgres)).not.toThrow();
    // A dialect the provider does not declare, another one or none at all.
    expect(() => buildEditor("kafka", CAPABILITIES.kafka, { ...kafka, dialect: redis })).toThrow(
      "kafka: the declaration states the query dialect redis, and its provider declares kafka",
    );
    expect(() => buildEditor("postgres", CAPABILITIES.postgres, { ...postgres, dialect: kafka.dialect })).toThrow(
      "postgres: the declaration states the query dialect kafka, and its provider declares none",
    );
    expect(() => buildEditor("kafka", CAPABILITIES.kafka, { ...kafka, dialect: null })).toThrow(
      "kafka: the declaration states the query dialect none, and its provider declares kafka",
    );
    // A query language the provider does not declare.
    const json = { ...postgres, language: { ...postgres.language, queryLanguage: "json" as const } };
    expect(() => buildEditor("postgres", CAPABILITIES.postgres, json)).toThrow(
      "postgres: the declaration states the query language json, and its provider declares sql",
    );
  });

  test("an agent overlay member the declaration has no place for, a grounding given as a value, and a pattern flag it does not take are refused by name by the generator", () => {
    const key = `k${crypto.randomUUID().replaceAll("-", "")}`;
    const postgres = engineServerOverlay("postgres");
    const mssql = engineServerOverlay("mssql");
    const dialectOf = (type: DatabaseType) => {
      const dialect = engineServerOverlay(type).dialect;
      if (dialect === undefined) throw new Error(`${type} has no dialect`);
      return dialect;
    };
    const catalogRead = dialectOf("postgres").catalogRead;
    const profile = dialectOf("mssql").profileComposition;
    if (catalogRead === "unsupported" || profile === "unsupported") throw new Error("postgres and mssql compose these");
    const flagged = (member: "incomparableType" | "uncountableType") => ({
      ...mssql,
      dialect: { ...dialectOf("mssql"), profileComposition: { ...profile, [member]: /text/g } },
    });

    expect(buildAgentOverlay("bigquery", null)).toBeNull();
    expect(() => buildAgentOverlay("bigquery", null, postgres)).toThrow(
      "bigquery: the engine speaks no statement language, so its agent overlay has no place in the engine declaration",
    );
    // The statement language is the declaration's: one authored as null on an engine whose overlay the registry holds
    // leaves that overlay no place, and the generator refuses it by name.
    expect(() => buildAgentOverlay("postgres", null)).toThrow(
      "postgres: the engine speaks no statement language, so its agent overlay has no place in the engine declaration",
    );
    expect(buildAgentOverlay("kafka", "kafkaread")).toEqual({ dialect: null, grounding: null });
    expect(buildAgentOverlay("cassandra", "sql")?.grounding).toBe("groundingOverride");
    for (const member of ["workflowToolRules", "answerNotADataRead"]) {
      expect(() =>
        buildAgentOverlay("postgres", "sql", { ...postgres, [member]: (base: unknown) => base } as typeof postgres),
      ).toThrow(`postgres: the agent overlay member "${member}" has no place in the engine declaration`);
    }
    expect(() => buildAgentOverlay("postgres", "sql", { ...postgres, [key]: null } as typeof postgres)).toThrow(
      `postgres: the agent overlay member "${key}" has no place in the engine declaration`,
    );
    expect(() =>
      buildAgentOverlay("postgres", "sql", {
        ...postgres,
        dialect: { ...dialectOf("postgres"), [key]: "unsupported" },
      } as typeof postgres),
    ).toThrow(`postgres: the agent overlay member "dialect.${key}" has no place in the engine declaration`);
    expect(() =>
      buildAgentOverlay("postgres", "sql", {
        ...postgres,
        dialect: { ...dialectOf("postgres"), catalogRead: { ...catalogRead, [key]: true } },
      } as typeof postgres),
    ).toThrow(`postgres: the agent overlay member "dialect.catalogRead.${key}" has no place in the engine declaration`);
    expect(() =>
      buildAgentOverlay("postgres", "sql", {
        ...postgres,
        dialect: {
          ...dialectOf("postgres"),
          catalogRead: { ...catalogRead, compose: { ...catalogRead.compose, [key]: () => "" } },
        },
      } as typeof postgres),
    ).toThrow(
      `postgres: the agent overlay member "dialect.catalogRead.compose.${key}" has no place in the engine declaration`,
    );
    expect(() =>
      buildAgentOverlay("mssql", "sql", {
        ...mssql,
        dialect: { ...dialectOf("mssql"), planEstimate: { kind: "partial", mode: "estimate-plan" } },
      } as unknown as typeof mssql),
    ).toThrow(
      'mssql: the agent overlay member "dialect.planEstimate.kind" is "partial", neither prefix nor session-mode',
    );
    expect(() =>
      buildAgentOverlay("cassandra", "sql", {
        ...engineServerOverlay("cassandra"),
        grounding: languageServerPack("sql").grounding,
      } as ReturnType<typeof engineServerOverlay>),
    ).toThrow(
      "cassandra: the agent overlay gives grounding as a value, which the declaration names only as a derivation",
    );
    for (const member of ["incomparableType", "uncountableType"] as const) {
      expect(() => buildAgentOverlay("mssql", "sql", flagged(member) as typeof mssql)).toThrow(
        `mssql: the profile type pattern ${member} has flags "g", which are not none, i, u or iu`,
      );
    }
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

/**
 * Studio's review record of each policy claim, by the member that requests it: the table of `src/lib/db/compatibility.ts`
 * every gate reads and each declaration's request is generated from (docs/providers/CONTRACT.md, clause M-52). Written
 * here apart from the generator, and typed by the schema's members, so a member the schema gains fails the typecheck
 * here until its record is named.
 */
const POLICY_CLAIM_RECORDS: { readonly [K in keyof PolicyClaims]: Readonly<Record<DatabaseType, PolicyClaims[K]>> } = {
  writeReach: WRITE_REACH,
  readsFileAccessPosture: READS_FILE_ACCESS_POSTURE,
  deniedFileAccessRefusal: REFUSES_DENIED_FILE_ACCESS,
  singleWriterFile: SINGLE_WRITER_FILE,
  readRootsRequired: READ_ROOTS_REQUIRED,
  // The record writes the pair, the form a user and a password take together, as null; a declaration names it `pair`.
  agentCredentialForm: Object.fromEntries(
    SHIPPED_DATABASE_TYPES.map((type) => [type, AGENT_CREDENTIAL_FORM[type] ?? "pair"]),
  ) as Record<DatabaseType, AgentCredentialFormClaim>,
  maskingExemptColumns: MASKING_EXEMPT_COLUMNS,
};

/** Studio's review record of each MCP claim, by the member that requests it, written as `POLICY_CLAIM_RECORDS` is. */
const MCP_CLAIM_RECORDS: { readonly [K in keyof McpClaims]: Readonly<Record<DatabaseType, McpClaims[K]>> } = {
  exposable: MCP_EXPOSABLE,
  statementRead: MCP_STATEMENT_READ,
  metadataReadChangesState: MCP_METADATA_READ_CHANGES_STATE,
  agentCredentialRequired: MCP_AGENT_CREDENTIAL_REQUIRED,
};

/** A provider's answer for one write path in the declaration's form: a proof or gate as its module and export. */
function writePathEvidence(path: WritePathReach): WritePathEvidence {
  if (path.reach === "gated") return { reach: "gated", gate: { module: path.gate.module, symbol: path.gate.symbol } };
  if (path.reach === "open") return { reach: "open" };
  return {
    reach: "absent",
    proof: path.proof === undefined ? null : { module: path.proof.module, symbol: path.proof.symbol },
  };
}

/**
 * A provider's write paths in the declaration's form: open on every path where it declares no write reach, the
 * reading Studio gives that absence, each declared path as declared, and a declared write reach that misses a path
 * refused by name.
 */
function declaredWritePaths(type: DatabaseType, declared: ProviderCapabilities["writeReach"]): WritePaths {
  const evidence = (path: WritePath): WritePathEvidence => {
    if (declared === undefined) return { reach: "open" };
    const reach: WritePathReach | undefined = declared[path];
    if (reach === undefined) throw new Error(`${type}: the provider declares a write reach with no ${path} path`);
    return writePathEvidence(reach);
  };
  return Object.fromEntries(WRITE_PATHS.map((path) => [path, evidence(path)])) as unknown as WritePaths;
}

/**
 * Each fact of the safeguards segment as its provider declares it, read from the provider's capabilities in the
 * declaration's form (docs/providers/CONTRACT.md, clause M-60): a provider that declares no write reach open on every
 * path, the reading Studio gives that absence, each metadata-only operation in the provider's order with its columns in
 * theirs, and null where the provider declares no metadata-only answer or no inline edit refusal. Written here apart
 * from the generator, and typed by the schema's members, so a member the schema gains fails the typecheck here until
 * its reader is named.
 */
const SAFEGUARD_FACTS: { readonly [K in keyof Safeguards]: (type: DatabaseType) => Safeguards[K] } = {
  writePaths: (type) => declaredWritePaths(type, CAPABILITIES[type].writeReach),
  metadataOnly: (type) => {
    const declared = CAPABILITIES[type].metadataOnly;
    if (declared === undefined) return null;
    return Object.entries(declared).map(([operation, columns]) => ({
      operation,
      columns: columns.map(({ column, kind }) => ({ column, kind })),
    }));
  },
  inlineEditRefusedColumns: (type) => {
    const declared = CAPABILITIES[type].inlineEditRefusedColumns;
    return declared === undefined ? null : { type: declared.type, reason: declared.reason };
  },
};

/**
 * Every member of Studio's maintenance spec, as a value. A record rather than a list, so a member Studio's spec gains
 * fails to compile here until the census places it.
 */
const STUDIO_MAINTENANCE_SPEC_MEMBERS: Readonly<Record<keyof MaintenanceOperationSpec, true>> = {
  label: true,
  perEntity: true,
  global: true,
  title: true,
  description: true,
  confirmation: true,
  preview: true,
  kinds: true,
};

/**
 * A provider's maintenance specs in the declaration's form (docs/providers/CONTRACT.md, clause M-64): one per operation
 * the provider lists, in its order, each member the provider leaves out written at its absence, null or false. Written
 * here apart from the generator, which reads the order from the engine's `ENGINE_FACETS` row: a listed operation with no
 * spec and a spec for an unlisted operation are each refused by name, as the generator refuses them.
 */
function declaredMaintenanceSpecs(type: DatabaseType, capabilities: ProviderCapabilities): MaintenanceSpec[] {
  const specs = capabilities.maintenanceOperationSpecs ?? {};
  for (const operation of Object.keys(specs) as MaintenanceOperation[]) {
    if (!capabilities.maintenanceOperations.includes(operation)) {
      throw new Error(
        `${type}: the provider declares a maintenance spec for ${operation}, which its engine's maintenance facet does not list`,
      );
    }
  }
  return capabilities.maintenanceOperations.map((operation) => {
    const spec = specs[operation];
    if (spec === undefined) throw new Error(`${type}: the provider declares no maintenance spec for ${operation}`);
    return {
      operation,
      label: spec.label,
      perEntity: spec.perEntity,
      global: spec.global,
      title: spec.title ?? null,
      description: spec.description ?? null,
      confirmation: spec.confirmation ?? null,
      preview: spec.preview === true,
      kinds: spec.kinds === undefined ? null : [...spec.kinds],
    };
  });
}

/** One declared spec back in Studio's form: null and false read as the member left out, its documented absence. */
function studioMaintenanceSpec(spec: MaintenanceSpec): MaintenanceOperationSpec {
  return {
    label: spec.label,
    perEntity: spec.perEntity,
    global: spec.global,
    ...(spec.title === null ? {} : { title: spec.title }),
    ...(spec.description === null ? {} : { description: spec.description }),
    ...(spec.confirmation === null ? {} : { confirmation: spec.confirmation }),
    ...(spec.preview ? { preview: true } : {}),
    ...(spec.kinds === null ? {} : { kinds: [...spec.kinds] }),
  };
}

/** A provider's capabilities with their maintenance half rebuilt from the engine's declaration alone. */
function maintenanceFromDeclaration(capabilities: ProviderCapabilities, d: EngineDeclaration): ProviderCapabilities {
  return {
    ...capabilities,
    supportsMaintenance: d.facets.maintenance.length > 0,
    maintenanceOperations: [...d.facets.maintenance],
    maintenanceOperationSpecs: Object.fromEntries(
      d.facets.maintenanceSpecs.map((spec) => [spec.operation, studioMaintenanceSpec(spec)]),
    ),
  };
}

/** How the census reads one claim of an earlier segment: the engine's request, and Studio's record of it. */
interface SegmentClaimRecord {
  /** The claim as the declaration requests it. */
  readonly request: (declaration: EngineDeclaration) => unknown;
  /** The row of Studio's review record for `type`, written in the declaration's form. */
  readonly record: (type: DatabaseType) => unknown;
}

/**
 * Studio's review record of each claim of the connection, facets, agent and SQL text segments, by the dotted member
 * that requests it (docs/providers/CONTRACT.md, clauses M-52 and M-53): the table every gate reads and each
 * declaration's request is generated from. Written here apart from the generator, as `POLICY_CLAIM_RECORDS` is.
 */
const SEGMENT_CLAIM_RECORDS: Readonly<Record<string, SegmentClaimRecord>> = {
  "connection.opensLocalFile": {
    request: (d) => d.connection.opensLocalFile,
    record: (type) => OPENS_LOCAL_FILE[type],
  },
  "connection.hostPathFields": {
    request: (d) => d.connection.hostPathFields,
    record: (type) => HOST_PATH_FIELDS[type],
  },
  "connection.serverLevelWithoutDatabase": {
    request: (d) => d.connection.serverLevelWithoutDatabase,
    record: (type) => OPENS_SERVER_LEVEL_WITHOUT_DATABASE[type],
  },
  "connection.sshTunnel": {
    request: (d) => (d.connection.sshTunnel.offered ? null : d.connection.sshTunnel.refusal),
    record: (type) => SSH_TUNNEL_REFUSAL[type],
  },
  "connection.agentCredential": {
    request: (d) => d.connection.agentCredential,
    record: (type) => {
      const row = SEED_AGENT_CREDENTIAL[type];
      return row === null ? null : { form: row.form, supersededBy: row.supersededBy };
    },
  },
  "agent.statementLanguage": {
    request: (d) => d.agent.statementLanguage,
    record: (type) => AGENT_STATEMENT_LANGUAGE[type],
  },
  "facets.agentReadings": {
    request: (d) => d.facets.agentReadings,
    record: (type) => ENGINE_FACETS[type].agentReadings,
  },
  "sqlText.redaction": {
    request: (d) => d.sqlText.redaction,
    record: (type) => SQL_TEXT_REDACTION[type],
  },
  "agent.overlay.dialect.catalogRead.commandShaped": {
    request: (d) => d.agent.overlay?.dialect?.catalogRead?.commandShaped ?? false,
    record: (type) => {
      const catalogRead = engineServerDialect(type).catalogRead;
      return catalogRead !== "unsupported" && catalogRead.commandShaped === true;
    },
  },
};

/** A record over the shipped ids, each id's value read from its committed declaration by `read`. */
function declaredRecord<Value>(read: (declaration: EngineDeclaration) => Value): Readonly<Record<DatabaseType, Value>> {
  return Object.fromEntries(SHIPPED_DATABASE_TYPES.map((type) => [type, read(declared(type))])) as Record<
    DatabaseType,
    Value
  >;
}

describe("the census", () => {
  test("displayName is the connection form's label", () => {
    expect(differing((type, d) => d.displayName === CONNECTION_FORM[type].label)).toEqual([]);
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

  test("connection.seedOnly is the engine's SEED_ONLY_FIELDS row, and every refusal Studio renders from it is the sentence the table gave", () => {
    const samples: readonly [string, string][] = [
      ["seed-one", "opensearch"],
      ["warehouse_2", "postgres"],
    ];
    // The sentences the table's functions gave before the rows were projected from the declarations, each written out
    // whole so the renderers are held to text no projection produced.
    const elasticsearchProjection = (id: string, type: string) =>
      `Seed connection "${id}" of type "${type}" carries an Elasticsearch API key pair. The pair is Elasticsearch-only; OpenSearch's security plugin has not been measured to accept Authorization: ApiKey, so the seed is refused rather than projected as a connection that silently falls back to user/password.`;
    const onlyOf = (engine: string) => (field: string) =>
      `${field} is ${engine} only: no other engine's provider reads it, so this connection would be listed as carrying it and would not. Remove ${field} from this connection.`;
    const refusals: Partial<Record<DatabaseType, (field: string) => string>> = {
      elasticsearch: () =>
        "apiKeyId and apiKeySecret are Elasticsearch-only. OpenSearch (and every other engine) refuses the pair: nothing here has measured whether OpenSearch's security plugin accepts Authorization: ApiKey, so a seed that carries it is rejected rather than listed as a connection that silently falls back to user/password.",
      modbus: onlyOf("Modbus"),
      netconf: onlyOf("NETCONF"),
      opcua: onlyOf("OPC UA"),
    };
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const row = SEED_ONLY_FIELDS[type];
      const seedOnly = d.connection.seedOnly;
      if (row === null || seedOnly === null) return row === seedOnly;
      const refusal = refusals[type];
      const projectionMatches =
        seedOnly.projectionRefusal === null
          ? row.projectionRefusal === null && type !== "elasticsearch"
          : samples.every(
              ([id, other]) => seedOnlyProjectionRefusal(row, id, other) === elasticsearchProjection(id, other),
            );
      return (
        sameList(seedOnly.fields, row.fields) &&
        seedOnly.scope === row.kind &&
        seedOnly.refusal === row.refusal &&
        seedOnly.projectionRefusal === row.projectionRefusal &&
        refusal !== undefined &&
        row.fields.every((field) => seedOnlyRefusal(row, field) === refusal(field)) &&
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

  test("connection.tls lists TLS modes exactly where the dialog offers the SSL panel", () => {
    const matches = (type: DatabaseType, d: EngineDeclaration): boolean => {
      const listsModes = d.connection.tls.modes.length > 0;
      return listsModes === offersSslPanel(type);
    };

    expect(differing(matches)).toEqual([]);
  });

  test("connection.opensLocalFile and serverLevelWithoutDatabase are their records", () => {
    expect(differing((type, d) => d.connection.opensLocalFile === OPENS_LOCAL_FILE[type])).toEqual([]);
    expect(
      differing((type, d) => d.connection.serverLevelWithoutDatabase === OPENS_SERVER_LEVEL_WITHOUT_DATABASE[type]),
    ).toEqual([]);
  });

  test("connectBudgetFor answers, for every engine, the budget its declaration states, or the host's default where it states null", () => {
    expect(
      differing((type, d) => connectBudgetFor(type) === (d.connection.connectBudgetMs ?? DEFAULT_CONNECT_BUDGET_MS)),
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

  test("facets.maintenanceSpecs is its provider's own maintenance specs, one for each operation its facet lists, in the facet's order", () => {
    const stated = (read: (spec: MaintenanceSpec) => boolean) =>
      SHIPPED_DATABASE_TYPES.filter((type) => declared(type).facets.maintenanceSpecs.some(read));

    expect(
      differing((type, d) => sameValue(d.facets.maintenanceSpecs, declaredMaintenanceSpecs(type, CAPABILITIES[type]))),
    ).toEqual([]);
    expect(
      differing((_type, d) =>
        sameList(
          d.facets.maintenanceSpecs.map((spec) => spec.operation),
          d.facets.maintenance,
        ),
      ),
    ).toEqual([]);
    // Vacuity: some engine declares a typed card, a typed target, a preview, its kinds and a spec placed nowhere.
    expect(stated((spec) => spec.confirmation === "typed" && spec.title !== null).length).toBeGreaterThan(0);
    expect(stated((spec) => spec.confirmation === "typed-target").length).toBeGreaterThan(0);
    expect(stated((spec) => spec.preview).length).toBeGreaterThan(0);
    expect(stated((spec) => spec.kinds !== null).length).toBeGreaterThan(0);
    expect(stated((spec) => !spec.perEntity && !spec.global).length).toBeGreaterThan(0);
  });

  test("maintenanceControl and declaredEntityOperations answer from each declaration what they answer from its provider, for every operation, placement and kind", () => {
    const operations = SCHEMA.$defs.maintenanceOperation?.enum as MaintenanceOperation[];
    const wrong: string[] = [];
    let asked = 0;
    for (const type of SHIPPED_DATABASE_TYPES) {
      const provider = CAPABILITIES[type];
      const rebuilt = maintenanceFromDeclaration(provider, declared(type));
      const kinds = [undefined, ...(provider.objectKinds ?? []).map((kind) => kind.id)];
      for (const kind of kinds) {
        if (!sameValue(declaredEntityOperations(rebuilt, kind), declaredEntityOperations(provider, kind))) {
          wrong.push(`${type} entity operations on ${kind ?? "any kind"}`);
        }
        for (const operation of operations) {
          for (const placement of ["perEntity", "global"] as const) {
            asked += 1;
            const answer = maintenanceControl(rebuilt, operation, placement, kind);
            if (!sameValue(answer, maintenanceControl(provider, operation, placement, kind))) {
              wrong.push(`${type} ${operation} ${placement} on ${kind ?? "any kind"}`);
            }
          }
        }
      }
    }

    expect(operations.length).toBe(11);
    expect(asked).toBeGreaterThan(SHIPPED_DATABASE_TYPES.length * operations.length * 2);
    expect(wrong).toEqual([]);
  });

  test("each declaration's maintenance specs hold exactly Studio's spec members and the operation they name", () => {
    const members = sorted(["operation", ...Object.keys(STUDIO_MAINTENANCE_SPEC_MEMBERS)]);
    const providerKeys = SHIPPED_DATABASE_TYPES.flatMap((type) =>
      Object.values(CAPABILITIES[type].maintenanceOperationSpecs ?? {}).flatMap((spec) => Object.keys(spec ?? {})),
    );

    expect(sorted(Object.keys(SCHEMA.$defs.maintenanceSpec?.properties ?? {}))).toEqual(members);
    expect(sorted(SCHEMA.$defs.maintenanceSpec?.required ?? [])).toEqual(members);
    expect(providerKeys.length).toBeGreaterThan(0);
    expect([...new Set(providerKeys)].filter((key) => !Object.hasOwn(STUDIO_MAINTENANCE_SPEC_MEMBERS, key))).toEqual(
      [],
    );
    expect(
      differing((_type, d) => d.facets.maintenanceSpecs.every((spec) => sameList(sorted(Object.keys(spec)), members))),
    ).toEqual([]);
  });

  test("a provider's maintenance spec missing for a listed operation, or given for an unlisted one, is refused by name, by the generator and by the census", () => {
    const { kill, ...withoutKill } = CAPABILITIES.postgres.maintenanceOperationSpecs ?? {};
    const missing = { ...CAPABILITIES.postgres, maintenanceOperationSpecs: withoutKill };
    const extra = {
      ...CAPABILITIES.postgres,
      maintenanceOperationSpecs: {
        ...CAPABILITIES.postgres.maintenanceOperationSpecs,
        compact: { label: "Compact", perEntity: false, global: true },
      },
    };
    const missingRefusal = "postgres: the provider declares no maintenance spec for kill";
    const extraRefusal =
      "postgres: the provider declares a maintenance spec for compact, which its engine's maintenance facet does not list";

    expect(kill).toBeDefined();
    expect(() => buildEngineDeclaration("postgres", missing, authored("postgres"))).toThrow(missingRefusal);
    expect(() => declaredMaintenanceSpecs("postgres", missing)).toThrow(missingRefusal);
    expect(() => buildEngineDeclaration("postgres", extra, authored("postgres"))).toThrow(extraRefusal);
    expect(() => declaredMaintenanceSpecs("postgres", extra)).toThrow(extraRefusal);
  });

  test("agent.statementLanguage is the engine's AGENT_STATEMENT_LANGUAGE row", () => {
    expect(differing((type, d) => d.agent.statementLanguage === AGENT_STATEMENT_LANGUAGE[type])).toEqual([]);
  });

  test("every name an agent overlay declaration states is its member's slot, and resolves through the census's slot table to the very function the engine's own overlay module exports there", () => {
    const slots = DECLARED_SLOTS as Readonly<Record<string, { readonly table: SlotTable; readonly path: string }>>;
    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) =>
        agentOverlayNames(declared(type)).flatMap(([path, name]) => {
          const held = valueAt(engineServerOverlay(type), path);
          const isSlot = slots[name]?.table === "AGENT_SERVER_OVERLAY" && slots[name]?.path === path;
          const overlayModule = moduleRow("AGENT_SERVER_OVERLAY", type);
          const resolved =
            isSlot && overlayModule !== undefined ? slotFunction(overlayModule, name as DeclaredSlotName) : undefined;
          return typeof resolved === "function" && resolved === held ? [] : [`${type}:${path}=${name}`];
        }),
      ),
    ).toEqual([]);
    // Vacuity: the schema states every agent overlay slot of the table as a function member, and some engine names
    // each of them.
    expect(sorted(AGENT_OVERLAY_FUNCTION_PATHS)).toEqual(sorted(tablePaths("AGENT_SERVER_OVERLAY")));
    const named = new Set(SHIPPED_DATABASE_TYPES.flatMap((type) => agentOverlayNames(declared(type)).map(([p]) => p)));
    expect(sorted([...named])).toEqual(sorted(tablePaths("AGENT_SERVER_OVERLAY")));
  });

  test("every function an engine's server overlay holds is named at its slot by its engine's declaration, and no slot the overlay leaves empty is named", () => {
    expect(
      LANGUAGE_ENGINES.flatMap(([type]) =>
        functionPaths(engineServerOverlay(type), "").flatMap((path) => {
          const name = slotNameAt("AGENT_SERVER_OVERLAY", path);
          return name !== undefined && valueAt(declared(type).agent.overlay, path) === name ? [] : [`${type}:${path}`];
        }),
      ),
    ).toEqual([]);
    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) =>
        agentOverlayNames(declared(type)).flatMap(([path, name]) =>
          typeof valueAt(engineServerOverlay(type), path) === "function" ? [] : [`${type}:${path}=${name}`],
        ),
      ),
    ).toEqual([]);
  });

  test("the server registry holds each engine module's overlay, member by member", () => {
    const differs = (type: DatabaseType): boolean => {
      const registry = engineServerOverlay(type) as Readonly<Record<string, unknown>>;
      const overlayModule = MODULE_AGENT_OVERLAYS.get(type) as Readonly<Record<string, unknown>> | undefined;
      if (overlayModule === undefined) return Object.keys(registry).length > 0;
      return (
        !sameList(Object.keys(registry), Object.keys(overlayModule)) ||
        Object.keys(overlayModule).some((member) => registry[member] !== overlayModule[member])
      );
    };

    expect(SHIPPED_DATABASE_TYPES.filter(differs)).toEqual([]);
    expect(MODULE_AGENT_OVERLAYS.size).toBe(LANGUAGE_ENGINES.length);
    expect(SHIPPED_DATABASE_TYPES.length).toBeGreaterThan(LANGUAGE_ENGINES.length);
  });

  test("every data member of each declared dialect is what the server registry's dialect holds, null where it is unsupported", () => {
    expect(
      differing((type, d) => {
        const { overlay } = d.agent;
        if (AGENT_STATEMENT_LANGUAGE[type] === null) return overlay === null;
        if (overlay === null) return false;
        const held = engineServerOverlay(type).dialect;
        if (overlay.dialect === null) return held === undefined;
        return held !== undefined && sameValue(declaredDialectData(overlay.dialect), dialectData(held));
      }),
    ).toEqual([]);
    // Vacuity: some engine states each plan form, the command flag, an uncountable pattern, a probe, a note and a
    // capture, and some SQL engine composes none of them.
    const dialects = SHIPPED_DATABASE_TYPES.flatMap((type) => {
      const dialect = declared(type).agent.overlay?.dialect;
      return dialect === null || dialect === undefined ? [] : [dialect];
    });
    expect(dialects.some((dialect) => dialect.planEstimate?.kind === "prefix")).toBe(true);
    expect(dialects.some((dialect) => dialect.planEstimate?.kind === "session-mode")).toBe(true);
    expect(dialects.some((dialect) => dialect.planEstimate === null)).toBe(true);
    expect(dialects.some((dialect) => dialect.catalogRead?.commandShaped === true)).toBe(true);
    expect(dialects.some((dialect) => dialect.catalogRead?.commandShaped === false)).toBe(true);
    expect(dialects.some((dialect) => (dialect.profileComposition?.uncountableType ?? null) !== null)).toBe(true);
    expect(dialects.some((dialect) => (dialect.statistics?.probe ?? null) !== null)).toBe(true);
    expect(dialects.some((dialect) => (dialect.statistics?.limitNote ?? null) !== null)).toBe(true);
    expect(dialects.some((dialect) => dialect.catalogCapture !== null)).toBe(true);
    expect(dialects.some((dialect) => dialect.catalogCapture === null)).toBe(true);
  });

  test("every engine's server facet, through runServerPack, is its family's with exactly the derivations its declaration names", () => {
    const wrong = LANGUAGE_ENGINES.flatMap(([type, family]) => {
      const facet = runServerPack(family, type) as unknown as Readonly<Record<string, unknown>>;
      const base = languageServerPack(family) as unknown as Readonly<Record<string, unknown>>;
      const overlay = declared(type).agent.overlay as unknown as Readonly<Record<string, unknown>> | null;
      return ENGINE_OVERRIDABLE_SERVER_MEMBERS.flatMap((member) => {
        const name = overlay !== null && Object.hasOwn(overlay, member) ? overlay[member] : null;
        if (name === null) return facet[member] === base[member] ? [] : [`${type}:${member}`];
        const overlayModule = moduleRow("AGENT_SERVER_OVERLAY", type);
        const derive =
          overlayModule !== undefined && typeof name === "string" && slotNameAt("AGENT_SERVER_OVERLAY", member) === name
            ? slotFunction(overlayModule, name)
            : undefined;
        return typeof derive === "function" && Bun.deepEquals(facet[member], derive(base[member]))
          ? []
          : [`${type}:${member}=${String(name)}`];
      });
    });

    expect(wrong).toEqual([]);
    expect(LANGUAGE_ENGINES.some(([type]) => declared(type).agent.overlay?.grounding !== null)).toBe(true);
  });

  test("each engine's family and client dialect, through the client registry, are its declared language and the client view of its declared dialect", () => {
    expect(
      differing((type, d) => {
        const { statementLanguage, overlay } = d.agent;
        if (engineFamily(type) !== statementLanguage) return false;
        if (statementLanguage === null) return true;
        const client = engineClientPack(type).dialect;
        const dialect = overlay?.dialect ?? null;
        return dialect === null ? client === undefined : sameValue(client, clientViewOf(dialect));
      }),
    ).toEqual([]);
  });

  test("the SQL catalog and composer requirements and the composed capture hold on exactly the engines whose declared dialect supplies them", () => {
    const supplying = (supplies: (dialect: NonNullable<SqlDialect>) => boolean): string[] =>
      sorted(
        SHIPPED_DATABASE_TYPES.filter((type) => {
          const dialect = declared(type).agent.overlay?.dialect ?? null;
          return dialect !== null && supplies(dialect);
        }),
      );
    const catalog = supplying((dialect) => dialect.catalogRead !== null);

    expect(sorted(AGENT_REQUIREMENT_ENGINES["sql-catalog"])).toEqual(catalog);
    expect(sorted(AGENT_REQUIREMENT_ENGINES["sql-composers"])).toEqual(
      supplying((dialect) => dialect.catalogRead !== null && dialect.planEstimate !== null),
    );
    expect(sorted(enginesSupporting("catalogCapture"))).toEqual(
      supplying((dialect) => dialect.catalogCapture !== null),
    );
    expect(catalog.length).toBeGreaterThan(0);
  });

  test("each declaration's agent overlay holds exactly the members of the schema's overlay and SQL dialect", () => {
    const overlayMembers = sorted(Object.keys(SCHEMA.$defs.agentOverlay?.properties ?? {}));
    const dialectMembers = sorted(Object.keys(SQL_SERVER_DIALECT_MEMBERS));

    expect(overlayMembers).toEqual(["dialect", "grounding"]);
    expect(sorted(SCHEMA.$defs.agentOverlay?.required ?? [])).toEqual(overlayMembers);
    expect(
      overlayMembers.filter((member) => ![...ENGINE_OVERRIDABLE_SERVER_MEMBERS, "dialect"].includes(member)),
    ).toEqual([]);
    expect(sorted(Object.keys(SCHEMA.$defs.sqlDialect?.properties ?? {}))).toEqual(dialectMembers);
    expect(sorted(SCHEMA.$defs.sqlDialect?.required ?? [])).toEqual(dialectMembers);
    expect(
      differing((_type, d) => {
        const { overlay } = d.agent;
        if (overlay === null) return true;
        if (!sameList(sorted(Object.keys(overlay)), overlayMembers)) return false;
        return overlay.dialect === null || sameList(sorted(Object.keys(overlay.dialect)), dialectMembers);
      }),
    ).toEqual([]);
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
      "kubernetes.connectionImport.load",
      "snowflake.fieldRules.host.check",
      "snowflake.hostHint",
      "snowflake.hostIdentity",
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
      // A paste reader is three operations under one name: the row's are the reader's, by identity, each one.
      const reader =
        paste === null ? undefined : (resolveNamed(type, paste.reader) as ConnectionStringPaste | undefined);
      const readerOperations =
        paste === null
          ? row.paste === null
          : reader !== undefined &&
            row.paste !== null &&
            typeof reader.claims === "function" &&
            row.paste.claims === reader.claims &&
            row.paste.names === reader.names &&
            row.paste.parse === reader.parse;
      return same(urlTls, row.readTls) && same(seedCheck, row.validateSeed) && readerOperations;
    };

    expect(differing(matches)).toEqual([]);
    expect(resolveNamed("postgres", "urlTls")).toBe(CONNECTION_STRING.postgres.readTls);
    expect((resolveNamed("postgres", "pasteReader") as ConnectionStringPaste).parse).toBe(
      CONNECTION_STRING.postgres.paste?.parse as ConnectionStringPaste["parse"],
    );
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
          offersSqlExport: row.offersSqlExport,
          historyMask: row.historyMask,
        });
      }),
    ).toEqual([]);
  });

  test("QUERY_DIALECTS is the dialect rows the declarations state, one per dialect, each opening tabs of its own name", () => {
    const derived = derivedDialects();

    expect(sorted(Object.keys(derived))).toEqual(sorted(Object.keys(QUERY_DIALECTS)));
    expect(
      Object.entries(QUERY_DIALECTS)
        .filter(([dialect, spec]) => spec.tabType !== dialect)
        .map(([dialect]) => dialect),
    ).toEqual([]);
    expect(
      (Object.keys(QUERY_DIALECTS) as QueryDialect[]).filter(
        (dialect) => !sameValue(derived[dialect], QUERY_DIALECTS[dialect]),
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
      differing((type, d) => sameValue(d.sqlText.redaction, declaredRedaction(SQL_GRAMMAR[type].redaction))),
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
      "mongodb.redaction.read",
      "postgres.completion.formatSegment",
      "postgres.completion.readQuotedQualifier",
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

  test("sqlWriting.inlineEdit is the row's, each type name set in its order and float64 as all where every key is", () => {
    expect(
      differing((type, d) => {
        const row = SQL_WRITING[type].inlineEdit;
        const edit = d.sqlWriting.inlineEdit;
        const float64 =
          row.float64TypeNames === "all"
            ? edit.float64TypeNames === "all"
            : edit.float64TypeNames !== "all" && sameList(edit.float64TypeNames, [...row.float64TypeNames]);
        return (
          sameList(edit.instantTypeNames, [...row.instantTypeNames]) &&
          sameList(edit.exactDecimalTypeNames, [...row.exactDecimalTypeNames]) &&
          float64
        );
      }),
    ).toEqual([]);
    // Vacuity: some engine keys every column float64 and some lists its float64 names, and the lists hold more than
    // one name, so their order is read.
    const edits = SHIPPED_DATABASE_TYPES.map((type) => declared(type).sqlWriting.inlineEdit);
    expect(edits.some((edit) => edit.float64TypeNames === "all")).toBe(true);
    expect(edits.some((edit) => edit.float64TypeNames !== "all" && edit.float64TypeNames.length > 1)).toBe(true);
    expect(edits.some((edit) => edit.instantTypeNames.length > 1 && edit.exactDecimalTypeNames.length > 1)).toBe(true);
  });

  test("sqlWriting.export states the row's DDL types, standing-alone names, bare spellings, non-finite literals and insert form", () => {
    expect(
      differing((type, d) => {
        const row = SQL_WRITING[type].export;
        const facts = d.sqlWriting.export;
        return (
          sameValue(facts.ddlTypes, row.ddlTypes) &&
          sameList(Object.keys(facts.ddlTypes), TYPE_FAMILY_KINDS) &&
          sameList(facts.standsAlone, [...row.standsAlone]) &&
          sameList(
            facts.bareSpelling.map(({ name, spelling }) => `${name}=${spelling}`),
            Object.entries(row.bareSpelling).map(([name, spelling]) => `${name}=${spelling}`),
          ) &&
          sameValue(facts.nonFinite, row.nonFinite) &&
          facts.insertForm === row.insertForm
        );
      }),
    ).toEqual([]);
    // Vacuity: some engine states a bare spelling, a standing-alone name, an INSERT written as a SELECT, a DDL type of
    // its own and a non-finite literal other than NULL.
    const facts = SHIPPED_DATABASE_TYPES.map((type) => declared(type).sqlWriting.export);
    expect(facts.some((fact) => fact.bareSpelling.length > 1)).toBe(true);
    expect(facts.some((fact) => fact.standsAlone.length > 1)).toBe(true);
    expect(facts.some((fact) => fact.insertForm === "select")).toBe(true);
    expect(new Set(facts.map((fact) => fact.ddlTypes.numeric)).size).toBeGreaterThan(1);
    expect(facts.some((fact) => Object.values(fact.nonFinite).some((literal) => literal !== "NULL"))).toBe(true);
  });

  test("sqlWriting.export.typeVocabulary is the row's, its bare type families grouped by kind and each pattern by its source and flags", () => {
    const pattern = ({ source, flags }: RegExp) => ({ source, flags });
    expect(
      differing((type, d) => {
        const row = SQL_WRITING[type].export.typeVocabulary;
        const vocabulary = d.sqlWriting.export.typeVocabulary;
        const families = vocabulary.bareTypeFamily as Readonly<Record<InferredKind, readonly string[]>>;
        const readBack = TYPE_FAMILY_KINDS.flatMap((kind) => families[kind].map((name) => [name, kind] as const));
        return (
          sameList(Object.keys(families), TYPE_FAMILY_KINDS) &&
          readBack.length === Object.keys(row.bareTypeFamily).length &&
          sameValue(Object.fromEntries(readBack), row.bareTypeFamily) &&
          sameValue(vocabulary.floatType, pattern(row.floatType)) &&
          sameValue(vocabulary.exactNumericType, pattern(row.exactNumericType)) &&
          sameValue(vocabulary.numericWrapper, pattern(row.numericWrapper))
        );
      }),
    ).toEqual([]);
    // Vacuity: the families span several kinds and the patterns carry flags, so neither is read back as a constant.
    const vocabulary = declared("postgres").sqlWriting.export.typeVocabulary;
    expect(TYPE_FAMILY_KINDS.filter((kind) => vocabulary.bareTypeFamily[kind].length > 0).length).toBeGreaterThan(3);
    expect(vocabulary.floatType.flags).toBe("i");
  });

  test("sqlWriting.export.createTableKey carries the row's note where the row has a key", () => {
    expect(
      differing((type, d) => {
        const row = SQL_WRITING[type].export.createTableKey;
        const key = d.sqlWriting.export.createTableKey;
        return row === undefined ? key === null : key !== null && key.note === row.note;
      }),
    ).toEqual([]);
    // Vacuity: some engine has a key the result cannot supply.
    expect(SHIPPED_DATABASE_TYPES.some((type) => declared(type).sqlWriting.export.createTableKey !== null)).toBe(true);
  });

  test("every name an SQL writing declaration states is its member's slot, and Studio's SQL writing function table binds it there to the function the engine's row runs", () => {
    const slots = DECLARED_SLOTS as Readonly<Record<string, { readonly path: string }>>;
    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) =>
        sqlWritingNames(declared(type)).flatMap(([path, name]) => {
          const held = valueAt(SQL_WRITING[type], path);
          const kind = SQL_WRITING_SLOT_KINDS[path];
          const bound = kind === undefined ? undefined : SQL_WRITING_FUNCTIONS[kind][type]?.[name];
          const isSlot = slots[name]?.path === path;
          return isSlot && typeof bound === "function" && bound === held ? [] : [`${type}:${path}=${name}`];
        }),
      ),
    ).toEqual([]);
    // Vacuity: the schema states every slot of the table as a function member, and the declarations name them.
    expect(sorted(SQL_WRITING_FUNCTION_PATHS)).toEqual(sorted(tablePaths("SQL_WRITING")));
    expect(sorted(Object.keys(SQL_WRITING_SLOT_KINDS))).toEqual(sorted(tablePaths("SQL_WRITING")));
    expect(SHIPPED_DATABASE_TYPES.flatMap((type) => sqlWritingNames(declared(type))).length).toBeGreaterThan(190);
  });

  test("every function an SQL writing row holds is named at its slot by its engine's declaration, and no slot the row leaves empty is named", () => {
    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) =>
        functionPaths(SQL_WRITING[type], "").flatMap((path) => {
          const name = slotNameAt("SQL_WRITING", path);
          return name !== undefined && valueAt(declared(type).sqlWriting, path) === name ? [] : [`${type}:${path}`];
        }),
      ),
    ).toEqual([]);
    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) =>
        sqlWritingNames(declared(type)).flatMap(([path, name]) =>
          typeof valueAt(SQL_WRITING[type], path) === "function" ? [] : [`${type}:${path}=${name}`],
        ),
      ),
    ).toEqual([]);
  });

  test("every slot of the census's slot table is filled by some shipped row of its table", () => {
    const names = Object.keys(DECLARED_SLOTS) as DeclaredSlotName[];

    const fills = (type: DatabaseType, name: DeclaredSlotName) => {
      const row = moduleRow(DECLARED_SLOTS[name].table, type);
      return row !== undefined && typeof slotFunction(row, name) === "function";
    };

    expect(names.filter((name) => !SHIPPED_DATABASE_TYPES.some((type) => fills(type, name)))).toEqual([]);
    expect(names.length).toBe(42);
    expect(names.filter((name) => DECLARED_SLOTS[name].table === "MIGRATION_DDL").length).toBe(12);
    expect(names.filter((name) => DECLARED_SLOTS[name].table === "SQL_ENGINE_GENERATORS").length).toBe(4);
    expect(names.filter((name) => DECLARED_SLOTS[name].table === "AGENT_SERVER_OVERLAY").length).toBe(13);
  });

  test("every member of an SQL writing row has its member in the declaration", () => {
    const specDeclaredAt: Readonly<Record<keyof SqlWritingSpec, string>> = {
      escapeLiteral: "escapeLiteral",
      unescapeLiteral: "unescapeLiteral",
      quoteIdentifier: "quoteIdentifier",
      placeholder: "placeholder",
      temporalLiteral: "temporalLiteral",
      inlineEdit: "inlineEdit",
      export: "export",
      insertDocuments: "insertDocuments",
    };
    const inlineEditDeclaredAt: Readonly<Record<keyof InlineEditSpec, string>> = {
      instantTypeNames: "instantTypeNames",
      exactDecimalTypeNames: "exactDecimalTypeNames",
      float64TypeNames: "float64TypeNames",
      boundEdit: "boundEdit",
    };
    const exportDeclaredAt: Readonly<Record<keyof ExportSpec, string>> = {
      ddlTypes: "ddlTypes",
      standsAlone: "standsAlone",
      bareSpelling: "bareSpelling",
      typeVocabulary: "typeVocabulary",
      binaryLiteral: "binaryLiteral",
      nonFinite: "nonFinite",
      insertForm: "insertForm",
      rewriteDeclared: "rewriteDeclared",
      declareFromSample: "declareFromSample",
      typedLiteral: "typedLiteral",
      columnWriters: "columnWriters",
      createTableKey: "createTableKey",
    };
    const vocabularyDeclaredAt: Readonly<Record<keyof ExportTypeVocabulary, string>> = {
      bareTypeFamily: "bareTypeFamily",
      floatType: "floatType",
      exactNumericType: "exactNumericType",
      numericWrapper: "numericWrapper",
    };
    const kindDeclaredAt: Readonly<Record<InferredKind, string>> = {
      text: "text",
      integer: "integer",
      numeric: "numeric",
      boolean: "boolean",
      timestamp: "timestamp",
      binary: "binary",
    };
    const nonFiniteDeclaredAt: Readonly<Record<NonFiniteWord, string>> = {
      NaN: "NaN",
      Infinity: "Infinity",
      "-Infinity": "-Infinity",
    };
    const tableKeyDeclaredAt: Readonly<Record<keyof NonNullable<ExportSpec["createTableKey"]>, string>> = {
      note: "note",
      clause: "clause",
    };
    const unplaced = (row: object, declaredAt: object, at: string) =>
      Object.keys(row)
        .filter((member) => !Object.hasOwn(declaredAt, member))
        .map((member) => `${at}${member}`);
    const placed = (declaration: object, declaredAt: object) =>
      Object.values(declaredAt).every((member) => Object.hasOwn(declaration, member));

    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) => {
        const row = SQL_WRITING[type];
        const facts = row.export;
        return [
          ...unplaced(row, specDeclaredAt, ""),
          ...unplaced(row.inlineEdit, inlineEditDeclaredAt, "inlineEdit."),
          ...unplaced(facts, exportDeclaredAt, "export."),
          ...unplaced(facts.ddlTypes, kindDeclaredAt, "export.ddlTypes."),
          ...unplaced(facts.nonFinite, nonFiniteDeclaredAt, "export.nonFinite."),
          ...unplaced(facts.typeVocabulary, vocabularyDeclaredAt, "export.typeVocabulary."),
          ...(facts.createTableKey === undefined
            ? []
            : unplaced(facts.createTableKey, tableKeyDeclaredAt, "export.createTableKey.")),
        ].map((member) => `${type}.${member}`);
      }),
    ).toEqual([]);
    expect(
      differing((_type, d) => {
        const { sqlWriting } = d;
        const facts = sqlWriting.export;
        return (
          placed(sqlWriting, specDeclaredAt) &&
          placed(sqlWriting.inlineEdit, inlineEditDeclaredAt) &&
          placed(facts, exportDeclaredAt) &&
          placed(facts.ddlTypes, kindDeclaredAt) &&
          placed(facts.nonFinite, nonFiniteDeclaredAt) &&
          placed(facts.typeVocabulary, vocabularyDeclaredAt) &&
          placed(facts.typeVocabulary.bareTypeFamily, kindDeclaredAt) &&
          (facts.createTableKey === null || placed(facts.createTableKey, tableKeyDeclaredAt))
        );
      }),
    ).toEqual([]);
  });

  test("migrationDdl states the row's table DDL, its refusal line, its transaction wrapper and its reasons in order", () => {
    expect(
      differing((type, d) => {
        const row = MIGRATION_DDL[type];
        const ddl = d.migrationDdl;
        if (ddl.tableDdl !== row.tableDdl || !sameList(ddl.reasons, row.reasons)) return false;
        if (row.tableDdl === "refused") {
          return ddl.tableDdl === "refused" && ddl.refusal === row.refusal && ddl.transactionWrapper === null;
        }
        const wrapper = row.transactionWrapper;
        const stated = ddl.transactionWrapper;
        return wrapper === null
          ? stated === null
          : stated !== null && stated.begin === wrapper.begin && stated.commit === wrapper.commit;
      }),
    ).toEqual([]);
    // Vacuity: some engine refuses and some writes, the wrappers hold two begin texts and a written engine has none,
    // and a written engine lists more than one reason, so their order is read.
    const segments = SHIPPED_DATABASE_TYPES.map((type) => declared(type).migrationDdl);
    const written = segments.filter((ddl) => ddl.tableDdl === "written");
    expect(segments.some((ddl) => ddl.tableDdl === "refused")).toBe(true);
    const begins = written.flatMap((ddl) => (ddl.transactionWrapper === null ? [] : [ddl.transactionWrapper.begin]));
    expect(new Set(begins).size).toBeGreaterThan(1);
    expect(written.some((ddl) => ddl.transactionWrapper === null)).toBe(true);
    expect(written.some((ddl) => ddl.reasons.length > 1)).toBe(true);
  });

  test("migrationDdl.createTable states the row's create table form", () => {
    expect(
      differing((type, d) => {
        const row = MIGRATION_DDL[type];
        const ddl = d.migrationDdl;
        if (row.tableDdl === "refused") return ddl.tableDdl === "refused";
        return ddl.tableDdl === "written" && ddl.createTable.kind === row.createTable.kind;
      }),
    ).toEqual([]);
    // Vacuity: some engine refuses its CREATE TABLE and some writes it.
    const kinds = SHIPPED_DATABASE_TYPES.flatMap((type) => {
      const ddl = declared(type).migrationDdl;
      return ddl.tableDdl === "written" ? [ddl.createTable.kind] : [];
    });
    expect(sorted([...new Set(kinds)])).toEqual(["refused", "written"]);
  });

  test("every name a migration DDL declaration states is its member's slot, and Studio's migration DDL function table binds it there to the function the engine's row runs", () => {
    const slots = DECLARED_SLOTS as Readonly<Record<string, { readonly table: SlotTable; readonly path: string }>>;
    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) =>
        migrationDdlNames(declared(type)).flatMap(([path, name]) => {
          const held = valueAt(MIGRATION_DDL[type], path);
          const kind = MIGRATION_DDL_SLOT_KINDS[path];
          const bound = kind === undefined ? undefined : MIGRATION_DDL_FUNCTIONS[kind][type]?.[name];
          const isSlot = slots[name]?.table === "MIGRATION_DDL" && slots[name]?.path === path;
          return isSlot && typeof bound === "function" && bound === held ? [] : [`${type}:${path}=${name}`];
        }),
      ),
    ).toEqual([]);
    // Vacuity: the schema states every migration DDL slot of the table as a function member, and the declarations name
    // them.
    expect(sorted(MIGRATION_DDL_FUNCTION_PATHS)).toEqual(sorted(tablePaths("MIGRATION_DDL")));
    expect(sorted(Object.keys(MIGRATION_DDL_SLOT_KINDS))).toEqual(sorted(tablePaths("MIGRATION_DDL")));
    expect(SHIPPED_DATABASE_TYPES.flatMap((type) => migrationDdlNames(declared(type))).length).toBeGreaterThan(160);
  });

  test("every function a migration DDL row holds is named at its slot by its engine's declaration, and no slot the row leaves empty is named", () => {
    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) =>
        functionPaths(MIGRATION_DDL[type], "").flatMap((path) => {
          const name = slotNameAt("MIGRATION_DDL", path);
          return name !== undefined && valueAt(declared(type).migrationDdl, path) === name ? [] : [`${type}:${path}`];
        }),
      ),
    ).toEqual([]);
    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) =>
        migrationDdlNames(declared(type)).flatMap(([path, name]) =>
          typeof valueAt(MIGRATION_DDL[type], path) === "function" ? [] : [`${type}:${path}=${name}`],
        ),
      ),
    ).toEqual([]);
  });

  test("every member of a migration DDL row has its member in the declaration", () => {
    const refusedDeclaredAt: Readonly<Record<keyof TableDdlRefused, string>> = {
      tableDdl: "tableDdl",
      refusal: "refusal",
      transactionWrapper: "transactionWrapper",
      reasons: "reasons",
    };
    const writtenDeclaredAt: Readonly<Record<keyof TableDdlWritten, string>> = {
      tableDdl: "tableDdl",
      transactionWrapper: "transactionWrapper",
      createTable: "createTable",
      columnDef: "columnDef",
      createIndex: "createIndex",
      dropIndex: "dropIndex",
      addForeignKey: "addForeignKey",
      dropForeignKey: "dropForeignKey",
      addColumn: "addColumn",
      dropColumn: "dropColumn",
      modifyColumn: "modifyColumn",
      dropTable: "dropTable",
      reasons: "reasons",
    };
    const createTableRefusedAt: Readonly<Record<keyof Extract<CreateTableDdl, { kind: "refused" }>, string>> = {
      kind: "kind",
      createTableRefusal: "createTableRefusal",
    };
    const createTableWrittenAt: Readonly<Record<keyof Extract<CreateTableDdl, { kind: "written" }>, string>> = {
      kind: "kind",
      primaryKey: "primaryKey",
      foreignKey: "foreignKey",
    };
    const wrapperDeclaredAt: Readonly<Record<keyof NonNullable<TableDdlWritten["transactionWrapper"]>, string>> = {
      begin: "begin",
      commit: "commit",
    };
    const unplaced = (row: object, declaredAt: object, at: string) =>
      Object.keys(row)
        .filter((member) => !Object.hasOwn(declaredAt, member))
        .map((member) => `${at}${member}`);
    const placed = (declaration: object, declaredAt: object) =>
      Object.values(declaredAt).every((member) => Object.hasOwn(declaration, member));
    const createTableAt = (kind: CreateTableDdl["kind"]) =>
      kind === "refused" ? createTableRefusedAt : createTableWrittenAt;

    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) => {
        const row = MIGRATION_DDL[type];
        if (row.tableDdl === "refused")
          return unplaced(row, refusedDeclaredAt, "").map((member) => `${type}.${member}`);
        return [
          ...unplaced(row, writtenDeclaredAt, ""),
          ...unplaced(row.createTable, createTableAt(row.createTable.kind), "createTable."),
          ...(row.transactionWrapper === null
            ? []
            : unplaced(row.transactionWrapper, wrapperDeclaredAt, "transactionWrapper.")),
        ].map((member) => `${type}.${member}`);
      }),
    ).toEqual([]);
    expect(
      differing((_type, d) => {
        const ddl = d.migrationDdl;
        if (ddl.tableDdl === "refused") return placed(ddl, refusedDeclaredAt);
        return (
          placed(ddl, writtenDeclaredAt) &&
          placed(ddl.createTable, createTableAt(ddl.createTable.kind)) &&
          (ddl.transactionWrapper === null || placed(ddl.transactionWrapper, wrapperDeclaredAt))
        );
      }),
    ).toEqual([]);
  });

  test("sqlGenerators is null exactly where the engine has no SQL_ENGINE_GENERATORS row, and states the row's count expression, COUNT(*) where it has none", () => {
    expect(
      differing((type, d) => {
        const row = sqlGeneratorRow(type);
        if (row === undefined) return d.sqlGenerators === null;
        return d.sqlGenerators !== null && d.sqlGenerators.countExpression === (row.countExpression ?? "COUNT(*)");
      }),
    ).toEqual([]);
    // Vacuity: some engine writes the shared forms and some does not, and some count is not the shared one.
    const segments = SHIPPED_DATABASE_TYPES.map((type) => declared(type).sqlGenerators);
    expect(segments.some((segment) => segment === null)).toBe(true);
    const counts = segments.flatMap((segment) => (segment === null ? [] : [segment.countExpression]));
    expect(counts).toContain("COUNT(*)");
    expect(counts.some((count) => count !== "COUNT(*)")).toBe(true);
  });

  test("every name an SQL generator declaration states is its member's slot, and Studio's SQL generator function table binds it there to the function the engine's row runs", () => {
    const slots = DECLARED_SLOTS as Readonly<Record<string, { readonly table: SlotTable; readonly path: string }>>;
    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) =>
        sqlGeneratorNames(declared(type)).flatMap(([path, name]) => {
          const held = valueAt(sqlGeneratorRow(type), path);
          const kind = SQL_GENERATOR_SLOT_KINDS[path];
          const bound = kind === undefined ? undefined : SQL_GENERATOR_FUNCTIONS[kind][type]?.[name];
          const isSlot = slots[name]?.table === "SQL_ENGINE_GENERATORS" && slots[name]?.path === path;
          return isSlot && typeof bound === "function" && bound === held ? [] : [`${type}:${path}=${name}`];
        }),
      ),
    ).toEqual([]);
    expect(sorted(Object.keys(SQL_GENERATOR_SLOT_KINDS))).toEqual(sorted(tablePaths("SQL_ENGINE_GENERATORS")));
    // Vacuity: the schema states every SQL generator slot of the table as a function member, and each form other than
    // the quoting is named on one row and null on another.
    expect(sorted(SQL_GENERATORS_FUNCTION_PATHS)).toEqual(sorted(tablePaths("SQL_ENGINE_GENERATORS")));
    const segments = SHIPPED_DATABASE_TYPES.flatMap((type) => {
      const segment = declared(type).sqlGenerators;
      return segment === null ? [] : [segment];
    });
    for (const form of ["table", "select", "selectList"] as const) {
      expect(segments.some((segment) => segment[form] === null)).toBe(true);
      expect(segments.some((segment) => segment[form] !== null)).toBe(true);
    }
  });

  test("every function an SQL generator row holds is named at its slot by its engine's declaration, and no slot the row leaves empty is named", () => {
    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) =>
        functionPaths(sqlGeneratorRow(type), "").flatMap((path) => {
          const name = slotNameAt("SQL_ENGINE_GENERATORS", path);
          return name !== undefined && valueAt(declared(type).sqlGenerators, path) === name ? [] : [`${type}:${path}`];
        }),
      ),
    ).toEqual([]);
    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) =>
        sqlGeneratorNames(declared(type)).flatMap(([path, name]) =>
          typeof valueAt(sqlGeneratorRow(type), path) === "function" ? [] : [`${type}:${path}=${name}`],
        ),
      ),
    ).toEqual([]);
  });

  test("every member of an SQL generator row has its member in the declaration", () => {
    const declaredAt: Readonly<Record<keyof SqlEngineGenerators, string>> = {
      quote: "quote",
      table: "table",
      select: "select",
      selectList: "selectList",
      countExpression: "countExpression",
    };

    expect(
      SHIPPED_DATABASE_TYPES.flatMap((type) =>
        Object.keys(sqlGeneratorRow(type) ?? {})
          .filter((member) => !Object.hasOwn(declaredAt, member))
          .map((member) => `${type}.${member}`),
      ),
    ).toEqual([]);
    expect(
      differing((_type, d) => {
        const segment = d.sqlGenerators;
        return segment === null || Object.values(declaredAt).every((member) => Object.hasOwn(segment, member));
      }),
    ).toEqual([]);
  });

  test("editor.language.queryLanguage is the query language the engine's unconnected provider declares", () => {
    expect(differing((type, d) => d.editor.language.queryLanguage === CAPABILITIES[type].queryLanguage)).toEqual([]);
    // Vacuity: every query language is some engine's.
    const languages = SHIPPED_DATABASE_TYPES.map((type) => declared(type).editor.language.queryLanguage);
    expect(sorted([...new Set(languages)])).toEqual(sorted(Object.keys(LANGUAGE_TAB_TYPES)));
  });

  test("a dialect-less engine's tabs take its query language's tab type, and a dialect engine's its dialect's name", () => {
    expect(differing((type, d) => resolveTabType(CAPABILITIES[type]) === declaredTabType(d))).toEqual([]);
    // Vacuity: some engine has a dialect and every query language opens some dialect-less engine's tabs.
    const dialectLess = SHIPPED_DATABASE_TYPES.map(declared).filter((d) => d.editor.dialect === null);
    expect(dialectLess.length).toBeLessThan(SHIPPED_DATABASE_TYPES.length);
    expect(sorted([...new Set(dialectLess.map(declaredTabType))])).toEqual(sorted(Object.values(LANGUAGE_TAB_TYPES)));
  });

  test("editor.language.monacoId is the Monaco language Studio's editor renders the engine's tabs in", () => {
    expect(
      differing(
        (type, d) =>
          d.editor.language.monacoId === DIALECT_EDITORS[declaredTabType(d)].monacoId &&
          editorLanguageOf(CAPABILITIES[type]) === d.editor.language.monacoId,
      ),
    ).toEqual([]);
  });

  test("editor.language.accent and console are the EDITOR_LANGUAGES row's, a console registered under its own Monaco id", () => {
    const rows: Readonly<Record<string, EditorLanguageContribution>> = EDITOR_LANGUAGES;
    expect(
      differing((_type, d) => {
        const { monacoId, accent, console } = d.editor.language;
        const row = Object.hasOwn(rows, monacoId) ? rows[monacoId] : undefined;
        if (row === undefined || row.accent !== accent || console !== (row.console !== undefined)) return false;
        return row.console === undefined || row.console.spec.id === monacoId;
      }),
    ).toEqual([]);
    // Vacuity: some language is a console dialect and some is not, and the accents differ.
    const languages = SHIPPED_DATABASE_TYPES.map((type) => declared(type).editor.language);
    expect(sorted([...new Set(languages.map((language) => language.console))])).toEqual(["false", "true"]);
    expect(new Set(languages.map((language) => language.accent)).size).toBeGreaterThan(1);
  });

  test("EDITOR_LANGUAGES and DIALECT_EDITORS are the editor language facts the declarations state, one per language and one per tab type", () => {
    const { languages, tabTypes } = derivedEditorLanguages();
    const rows: Readonly<Record<string, EditorLanguageContribution>> = EDITOR_LANGUAGES;

    expect(sorted(Object.keys(languages))).toEqual(sorted(Object.keys(EDITOR_LANGUAGES)));
    expect(
      Object.keys(languages).filter(
        (monacoId) =>
          languages[monacoId].accent !== rows[monacoId]?.accent ||
          languages[monacoId].console !== (rows[monacoId]?.console !== undefined),
      ),
    ).toEqual([]);
    expect(Object.fromEntries(Object.entries(tabTypes).map(([tabType, { monacoId }]) => [tabType, monacoId]))).toEqual(
      Object.fromEntries(Object.entries(DIALECT_EDITORS).map(([tabType, { monacoId }]) => [tabType, monacoId])),
    );
    expect(Object.keys(languages).length).toBe(16);
    expect(Object.keys(tabTypes).length).toBe(24);
  });

  test("every member of an editor language row and of a tab type's editor row has its member in the declaration, or stays browser code", () => {
    const languageDeclaredAt: Readonly<Record<keyof EditorLanguageContribution, string | null>> = {
      monacoId: "monacoId",
      accent: "accent",
      console: "console",
      register: null,
      completions: null,
      format: null,
    };
    const tabEditorDeclaredAt: Readonly<Record<keyof DialectEditor, string>> = { monacoId: "monacoId" };
    const unplaced = (rows: Readonly<Record<string, object>>, declaredAt: object) =>
      Object.entries(rows).flatMap(([key, row]) =>
        Object.keys(row)
          .filter((member) => !Object.hasOwn(declaredAt, member))
          .map((member) => `${key}.${member}`),
      );
    const stated = Object.values(languageDeclaredAt).filter((member) => member !== null);

    expect(unplaced(EDITOR_LANGUAGES, languageDeclaredAt)).toEqual([]);
    expect(unplaced(DIALECT_EDITORS, tabEditorDeclaredAt)).toEqual([]);
    expect(differing((_type, d) => stated.every((member) => Object.hasOwn(d.editor.language, member)))).toEqual([]);
  });

  test("every claim of the policy and MCP segments is the row of Studio's review record of it", () => {
    const policyMembers = Object.keys(POLICY_CLAIM_RECORDS) as (keyof PolicyClaims)[];
    const mcpMembers = Object.keys(MCP_CLAIM_RECORDS) as (keyof McpClaims)[];
    const readBack = [
      ...policyMembers.map(
        (member) =>
          [
            `policy.${member}`,
            differing((type, d) => sameValue(d.policy[member], POLICY_CLAIM_RECORDS[member][type])),
          ] as const,
      ),
      ...mcpMembers.map(
        (member) =>
          [`mcp.${member}`, differing((type, d) => d.mcp[member] === MCP_CLAIM_RECORDS[member][type])] as const,
      ),
    ];

    expect(readBack.filter(([, ids]) => ids.length > 0).map(([claim, ids]) => `${claim}: ${ids.join(", ")}`)).toEqual(
      [],
    );
    expect(readBack.length).toBe(11);
  });

  test("every fact of the safeguards segment is its provider's own declaration", () => {
    const facts = Object.keys(SAFEGUARD_FACTS) as (keyof Safeguards)[];
    const readBack = facts.map(
      (fact) =>
        [
          `safeguards.${fact}`,
          differing((type, d) => sameValue(d.safeguards[fact], SAFEGUARD_FACTS[fact](type))),
        ] as const,
    );
    const stated = (read: (d: EngineDeclaration) => boolean) =>
      SHIPPED_DATABASE_TYPES.filter((type) => read(declared(type)));

    expect(readBack.filter(([, ids]) => ids.length > 0).map(([fact, ids]) => `${fact}: ${ids.join(", ")}`)).toEqual([]);
    expect(readBack.length).toBe(3);
    // Vacuity: some provider declares no write reach and some does, with an editor proof and a gate among them, and
    // some declares a metadata-only answer and an inline edit refusal.
    const paths = (d: EngineDeclaration) => Object.values(d.safeguards.writePaths);
    expect(stated((d) => paths(d).every((path) => path.reach === "open")).length).toBeGreaterThan(0);
    expect(stated((d) => d.safeguards.writePaths.editor.reach === "absent").length).toBeGreaterThan(0);
    expect(stated((d) => paths(d).some((path) => path.reach === "gated")).length).toBeGreaterThan(0);
    expect(stated((d) => d.safeguards.metadataOnly !== null).length).toBeGreaterThan(0);
    expect(stated((d) => d.safeguards.inlineEditRefusedColumns !== null).length).toBeGreaterThan(0);
  });

  test("each declaration's safeguards segment holds exactly the facts the census reads back to the providers", () => {
    const facts = sorted(Object.keys(SAFEGUARD_FACTS));

    expect(sorted(Object.keys(SCHEMA.$defs.safeguards?.properties ?? {}))).toEqual(facts);
    expect(sorted(SCHEMA.$defs.safeguards?.required ?? [])).toEqual(facts);
    expect(differing((_type, d) => sameList(sorted(Object.keys(d.safeguards)), facts))).toEqual([]);
  });

  test("a declared write reach that misses a path is refused by name by the census, and the generator writes the authored safeguards whatever the provider declares", () => {
    const { editor, objectEdit, maintenance } = CAPABILITIES.etcd.writeReach ?? {};
    const partial = { editor, objectEdit, maintenance } as unknown as ProviderCapabilities["writeReach"];
    const refusal = "etcd: the provider declares a write reach with no transaction path";

    expect(CAPABILITIES.etcd.writeReach).toBeDefined();
    // The safeguards are authored, so the generator builds none from the provider: the census reads them back to it.
    expect(
      buildEngineDeclaration("etcd", { ...CAPABILITIES.etcd, writeReach: partial }, authored("etcd")).safeguards,
    ).toEqual(declared("etcd").safeguards);
    expect(() => declaredWritePaths("etcd", partial)).toThrow(refusal);
    // The documented absence stays open on every path.
    expect(Object.values(declaredWritePaths("etcd", undefined)).map((path) => path.reach)).toEqual([
      "open",
      "open",
      "open",
      "open",
    ]);
  });

  test("the validator admits a write reach claim exactly where it is Studio's summary of the write paths", () => {
    const validator = compileManifestValidator(readFileSync(SCHEMA_FILE));
    const gate = { module: "src/lib/db/read-only-gate.ts", symbol: "refuseWrites" };
    const kafka = declared("kafka");
    const reaches: readonly WritePathReach[] = [
      { reach: "absent", proof: { module: "src/lib/db/read-policy.ts", symbol: "READS" } },
      { reach: "gated", gate },
      { reach: "open" },
    ];
    const combinations: Record<WritePath, WritePathReach>[] = reaches.flatMap((editor) =>
      reaches.flatMap((objectEdit) =>
        reaches.flatMap((maintenance) =>
          reaches.map((transaction) => ({ editor, objectEdit, maintenance, transaction })),
        ),
      ),
    );
    const wrong: string[] = [];
    for (const paths of combinations) {
      const summary = summarizeWriteReach(paths);
      for (const request of ["none", "guarded", "open"] as const) {
        const writePaths = Object.fromEntries(
          WRITE_PATHS.map((path) => [path, writePathEvidence(paths[path])]),
        ) as unknown as WritePaths;
        const changed: EngineDeclaration = {
          ...kafka,
          policy: { ...kafka.policy, writeReach: request },
          safeguards: { ...kafka.safeguards, writePaths },
        };
        if (validator.validateEngine(changed).admitted !== (request === summary)) {
          wrong.push(`${WRITE_PATHS.map((path) => paths[path].reach).join("/")} requesting ${request}`);
        }
      }
    }

    expect(combinations.length).toBe(81);
    expect(wrong).toEqual([]);
  });

  test("every claim of the connection, facets, agent and SQL text segments is the row of Studio's review record of it", () => {
    const readBack = Object.entries(SEGMENT_CLAIM_RECORDS).map(
      ([member, { request, record }]) => [member, differing((type, d) => sameValue(request(d), record(type)))] as const,
    );

    expect(readBack.filter(([, ids]) => ids.length > 0).map(([claim, ids]) => `${claim}: ${ids.join(", ")}`)).toEqual(
      [],
    );
    expect(readBack.map(([member]) => member)).toEqual([...SEGMENT_CLAIMS]);
  });

  test("each claim the census reads back is a member of the schema's engine declaration", () => {
    // A dotted claim is walked member by member from the engine declaration, each member's `$ref` followed into the
    // definition it names, a nullable definition included, and its last member must be a property of where it ends.
    const isMember = (claim: string): boolean => {
      const members = claim.split(".");
      let definition = SCHEMA.$defs.engineDeclaration;
      for (const [index, member] of members.entries()) {
        const properties = definition?.properties ?? {};
        if (!Object.hasOwn(properties, member)) return false;
        if (index === members.length - 1) return true;
        const reference = (properties[member] as { $ref?: string }).$ref ?? "";
        definition = SCHEMA.$defs[reference.replace("#/$defs/", "")];
      }
      return false;
    };

    expect(Object.keys(SEGMENT_CLAIM_RECORDS).filter((claim) => !isMember(claim))).toEqual([]);
    expect(Object.keys(SEGMENT_CLAIM_RECORDS)).toEqual([...SEGMENT_CLAIMS]);
    expect(isMember("agent.overlay.dialect.catalogRead.unknown")).toBe(false);
    expect(isMember("agent.overlay.dialect.catalogRead")).toBe(true);
  });

  test("READ_ONLY_ENFORCED is true exactly where the declaration's write reach is not open", () => {
    expect(differing((type, d) => READ_ONLY_ENFORCED[type] === (d.policy.writeReach !== "open"))).toEqual([]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => READ_ONLY_ENFORCED[type]).length).toBeGreaterThan(0);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => !READ_ONLY_ENFORCED[type]).length).toBeGreaterThan(0);
  });

  test("each declaration's policy and MCP segments hold exactly the claims Studio keeps a review record of", () => {
    const policyMembers = sorted(Object.keys(POLICY_CLAIM_RECORDS));
    const mcpMembers = sorted(Object.keys(MCP_CLAIM_RECORDS));

    expect(sorted(Object.keys(SCHEMA.$defs.policyClaims?.properties ?? {}))).toEqual(policyMembers);
    expect(sorted(SCHEMA.$defs.policyClaims?.required ?? [])).toEqual(policyMembers);
    expect(sorted(Object.keys(SCHEMA.$defs.mcpClaims?.properties ?? {}))).toEqual(mcpMembers);
    expect(sorted(SCHEMA.$defs.mcpClaims?.required ?? [])).toEqual(mcpMembers);
    expect(
      differing(
        (_type, d) =>
          sameList(sorted(Object.keys(d.policy)), policyMembers) && sameList(sorted(Object.keys(d.mcp)), mcpMembers),
      ),
    ).toEqual([]);
  });

  test("MCP serves statements on exactly the engines the declarations' claims and Studio's agent execution record give it", () => {
    const exposure: McpExposure = {
      executes: AGENT_EXECUTION_ENGINES,
      exposable: declaredRecord((d) => d.mcp.exposable),
      statementRead: declaredRecord((d) => d.mcp.statementRead),
      language: declaredRecord((d) => d.agent.statementLanguage) as unknown as McpExposure["language"],
    };
    const languages = (SCHEMA.$defs.statementLanguage?.enum ?? []).filter(
      (language): language is AgentStatementLanguageId => language !== null,
    );
    const served = languages.map((language) => [language, mcpStatementEngines(language, exposure)] as const);

    expect(
      served.filter(([language, engines]) => !sameList(engines, mcpStatementEngines(language))).map(([l]) => l),
    ).toEqual([]);
    expect(languages.length).toBeGreaterThan(0);
    expect(served.some(([, engines]) => engines.length > 0)).toBe(true);
  });

  test("agent mode opens a workflow on exactly the engines the declarations' statement languages and readings and Studio's agent execution record give it", () => {
    const tables = {
      languages: declaredRecord((d) => d.agent.statementLanguage) as Readonly<
        Record<DatabaseType, AgentStatementLanguageId | null>
      >,
      variants: AGENT_WORKFLOW_VARIANTS,
      requirementEngines: {
        ...AGENT_REQUIREMENT_ENGINES,
        "agent-readings": SHIPPED_DATABASE_TYPES.filter((type) => declared(type).facets.agentReadings.length > 0),
      },
      reviewed: AGENT_EXECUTION_ENGINES,
    };
    // The SQL record is total over the workflows, so every workflow of every language is among its keys.
    const workflows = Object.keys(AGENT_WORKFLOW_VARIANTS.sql) as AgentRunWorkflowType[];
    const modes: readonly AgentRunMode[] = ["planning", "agent"];
    const answers = SHIPPED_DATABASE_TYPES.flatMap((type) =>
      modes.flatMap((mode) =>
        workflows.map((workflow) => ({
          key: `${type} ${mode} ${workflow}`,
          declared: workflowAvailability(mode, workflow, type, tables),
          recorded: workflowAvailability(mode, workflow, type),
        })),
      ),
    );

    expect(answers.filter(({ declared, recorded }) => !sameValue(declared, recorded)).map(({ key }) => key)).toEqual(
      [],
    );
    // Vacuity: some engine opens operations and no statement workflow, and some opens a statement workflow.
    const opens = (type: DatabaseType, workflow: AgentRunWorkflowType): boolean =>
      workflowAvailability("agent", workflow, type, tables).open;
    const statementWorkflows = workflows.filter((workflow) => workflow !== "operations");
    expect(
      SHIPPED_DATABASE_TYPES.some(
        (type) => opens(type, "operations") && !statementWorkflows.some((workflow) => opens(type, workflow)),
      ),
    ).toBe(true);
    expect(SHIPPED_DATABASE_TYPES.some((type) => statementWorkflows.some((workflow) => opens(type, workflow)))).toBe(
      true,
    );
  });

  test("the confirmation gate's claims each declaration makes are the entries Studio's review record lists for its engine", () => {
    // A vocabulary row's `decidesAlone` is no declaration's, so only these two kinds are read back.
    const made = SHIPPED_DATABASE_TYPES.flatMap((type) => {
      const { readsSqlText, grammar } = declared(type).sqlText;
      return [
        ...(readsSqlText ? [] : [{ label: `${type} text-not-sql`, claim: { kind: "text-not-sql", type } as const }]),
        ...grammar.confirmExemptForms.map((form) => ({
          label: `${type} exempt-form ${form.join(" ")}`,
          claim: { kind: "exempt-form", type, form } as const,
        })),
      ];
    });
    const listed = CONFIRMATION_CLAIM_REVIEW.flatMap(({ claim }) => {
      if (claim.kind === "text-not-sql") return [`${claim.type} text-not-sql`];
      return claim.kind === "exempt-form" ? [`${claim.type} exempt-form ${claim.form.join(" ")}`] : [];
    });

    expect({
      unreviewed: made.filter(({ claim }) => !isReviewedConfirmationClaim(claim)).map(({ label }) => label),
      unmade: listed.filter((label) => !made.some((claim) => claim.label === label)),
    }).toEqual({ unreviewed: [], unmade: [] });
    // Vacuity: both kinds are made by some declaration.
    expect(new Set(made.map(({ claim }) => claim.kind)).size).toBe(2);
  });

  test("connection.readsTrustMaterial is the engine's READS_TRUST_MATERIAL row", () => {
    expect(differing((type, d) => d.connection.readsTrustMaterial === READS_TRUST_MATERIAL[type])).toEqual([]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => declared(type).connection.readsTrustMaterial)).toEqual(
      SHIPPED_DATABASE_TYPES.filter((type) => READS_TRUST_MATERIAL[type]),
    );
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
      Equal<keyof DdlTypeSpellings, InferredKind>,
      Equal<keyof TypeFamilies, InferredKind>,
      Equal<keyof NonFiniteLiterals, NonFiniteWord>,
      Equal<InsertForm, ExportSpec["insertForm"]>,
      Equal<MigrationDdl["tableDdl"], MigrationDdlSpec["tableDdl"]>,
      Equal<CreateTable["kind"], CreateTableDdl["kind"]>,
      Equal<QueryLanguage, ProviderCapabilities["queryLanguage"]>,
      Equal<MonacoLanguageId, EditorLanguage>,
      Equal<WriteReachClaim, WriteReach>,
      Equal<keyof WritePaths, WritePath>,
      Equal<WritePathEvidence["reach"], WritePathReach["reach"]>,
      Equal<MetadataOnlyKind, MetadataKind>,
      Equal<Exclude<AgentCredentialFormClaim, "pair">, ProviderAgentCredentialForm>,
      Equal<Exclude<keyof MaintenanceSpec, "operation">, keyof MaintenanceOperationSpec>,
      Equal<Exclude<MaintenanceConfirmation, null>, NonNullable<MaintenanceOperationSpec["confirmation"]>>,
      Equal<keyof NonNullable<SqlDialect>, keyof SqlServerDialect>,
      Equal<CatalogKind, AgentCatalogKind>,
      Equal<keyof CatalogCompose, AgentCatalogKind>,
      Equal<PlanEstimateSessionMode["mode"], Extract<AgentPlanEstimate, { kind: "session-mode" }>["mode"]>,
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

    expect<readonly boolean[]>(parity).toEqual(Array.from({ length: 40 }, () => true));
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

  test("the query languages and the editor languages are Studio's", () => {
    const queryLanguages: Readonly<Record<ProviderCapabilities["queryLanguage"], true>> = {
      sql: true,
      json: true,
      promql: true,
      cypher: true,
      influxql: true,
    };

    expect(sorted(enumOf("queryLanguage"))).toEqual(sorted(Object.keys(queryLanguages)));
    expect(sorted(enumOf("monacoLanguageId"))).toEqual(sorted(Object.keys(EDITOR_LANGUAGES)));
  });
});
