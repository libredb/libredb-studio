#!/usr/bin/env bun
/**
 * Writes src/lib/db/engine-declarations/<type-id>.json, one engine declaration per shipped type-id, from its authored
 * members, today's per-engine tables and what each engine's provider declares before it connects
 * (docs/providers/CONTRACT.md, clause M-15).
 *
 * A declaration's authored members, `AUTHORED_MEMBERS` (`id`, `displayName`, `location`, and of `connection` its
 * `fields`, `defaults`, `seedOnly`, `refused`, of its `connectionString` the `accepted`, `dialogOffersUri`, `scheme`,
 * `urlTls`, `paste` and `seedCheck`, and its `tls`, `readsTrustMaterial`, `dialog`, `hostUriSchemes`,
 * `credentialWarnings`, `fieldRules`, `hostHint`, `hostIdentity`, `import` and `connectBudgetMs`, and of `editor` its
 * `commitKeyword`, `consentDeadline` and `fenceAliases`), are written in the declaration itself: this script reads them
 * from the committed file of the engine in src/lib/db/engine-declarations, whatever directory `--out` names, with
 * `authoredMembersOf` (scripts/generate-engine-catalog.ts), which refuses by name a file that lacks one or whose `id`
 * is not its file name, and writes them back unchanged. Every other member is built from the tables. The engine
 * catalog, the connection tables, the connection forms, the connection strings, and the execution UI and fence aliases
 * (scripts/generate-engine-catalog.ts, clauses M-70, M-71, M-72, M-74 and M-75) project the authored members, and
 * `bun run engines:generate` runs that command's `--write` first and its `--check` last: this script builds every
 * provider through the factory, which builds only an engine the catalog holds, and `--check` admits every declaration
 * this script wrote, with the SDK validator's rules, which refuse by name, among others, a dialog entry or a field rule
 * for a field the engine does not take and a placeable field with no placement. A new engine's declaration therefore
 * starts as a copy of another engine's file with its authored members written for the new engine; the catalog generator
 * projects it, this script writes every other member, and the catalog generator then admits it.
 *
 * Each file is a `#/$defs/engineDeclaration` of the provider manifest schema
 * (packages/provider-sdk/src/manifest/manifest.schema.json): the engine's identity, its connection facts, its facets,
 * the statement language agent mode sends it, its editor facts that are data with the language its tabs are written and
 * rendered in, its SQL text facts, its SQL writing facts, its migration DDL facts, its SQL generator forms, and its
 * policy and MCP claims. A full
 * manifest also states the package's runtime and the products it was measured against, facts no provider in
 * `src/lib/db/providers/` has yet, so they are written when a provider moves into a package of its own, from this
 * declaration.
 *
 * The files are committed and never edited by hand outside their authored members, so a change to any table they
 * come from lands with its declaration diff. tests/unit/db/engine-declarations.test.ts rebuilds each in memory and
 * fails on any byte of difference, holds each to the schema, and reads each back to every table with read-back
 * functions of its own.
 *
 * A function a table holds is named, never carried, and named by the slot it fills, one convention for every
 * engine: written by hand in the authored connection string members, `urlTls` for the connection string's URL TLS
 * reader, `pasteReader` for its paste reader (one name for the reader's claims, names and parse) and `seedCheck` for
 * its seed load check, which Studio's connection string function table in src/lib/db/connection-string/index.ts binds,
 * and, written by hand in the authored connection form members, `<field>Check` for a field rule's check (`hostCheck`),
 * `hostHint` and `hostIdentity` for the Host text readers and `importer` for the connection import's parser, which
 * Studio's function table in src/lib/db/connection-form.ts binds. The name is read from where the function sits, never
 * from the function itself, so this script imports no provider module directly and reads no function's `name`; the
 * census resolves each name with a table of its own and holds it, by identity, to the function the connection form or
 * the connection string row holds.
 *
 * The SQL text facts come from the engine's row in `SQL_GRAMMAR`. A grammar fact the SDK's `SqlGrammar` type may leave
 * out is written at the reading its readers give that absence, false, an empty list, true for `dollarTags`,
 * `postgresql` for the formatter language and two empty lists for the completion words, except the two backslash
 * overrides and `confirmConfigKeys`, which are null where they are left out, since each has a reading no value of its
 * type gives. Each trailing limit clause is written as its source and flags, each word set as an array in its iteration
 * order, and each function named by its slot: `redactionReader` for a command redaction's reader, `formatSegment` and
 * `readQuotedQualifier` for the completion readers. The generator refuses by name a member of the row it has no place
 * for and a trailing limit clause whose flags are not i or iu.
 *
 * The SQL writing facts come from the engine's row in `SQL_WRITING`, member by member with the row's names and nesting,
 * a hook the row leaves out written null. Each function is named by its slot: `escapeLiteral`, `unescapeLiteral`,
 * `quoteIdentifier`, `placeholder`, `temporalLiteral`, `insertDocuments`, `boundEdit`, `binaryLiteral`,
 * `rewriteDeclared`, `declareFromSample`, `typedLiteral`, `columnWriters` and `createTableKeyClause` for the create
 * table key's clause. A type name set is written as an array in its iteration order, `all` as itself, each type pattern
 * as its source and flags, and the two records keyed by type name as lists: the bare spellings as `{ name, spelling }`
 * entries in the record's key order, and the bare type families as six lists keyed by kind, each in the record's key
 * order. The generator refuses by name a member of the row it has no place for, a type pattern whose flags are not
 * none, i, u or iu, and a bare type family that is not an inferred kind.
 *
 * The migration DDL facts come from the engine's row in `MIGRATION_DDL`, in the row's form: refused, with its refusal
 * line, its null transaction wrapper and its reasons, or written, member by member with the row's names and nesting.
 * The transaction wrapper is written as `{ begin, commit }` or null, the CREATE TABLE by its kind, and the reasons as an
 * array in the row's order. Each function is named by its slot: `createTablePrimaryKey` and `createTableForeignKey` for
 * a written CREATE TABLE's key writers, `createTableRefusal` for a refused one's line, and `columnDef`, `createIndex`,
 * `dropIndex`, `addForeignKey`, `dropForeignKey`, `addColumn`, `dropColumn`, `modifyColumn` and `dropTable` for the
 * statement writers. The generator refuses by name a member of the row, of its CREATE TABLE or of its transaction
 * wrapper it has no place for, and a table DDL or CREATE TABLE form that is neither refused nor written.
 *
 * The SQL generator forms come from the engine's row in `SQL_ENGINE_GENERATORS`, read as an own key: null where the
 * engine has no row and writes Studio's shared forms; otherwise each member in the schema's order, each form named by
 * its slot (`generatorQuote`, `generatorTable`, `generatorSelect` and `generatorSelectList`) or null where the row
 * leaves it out, and the count expression as the row's, `COUNT(*)` where the row leaves it out, the reading Generate
 * Count Query gives that absence. The generator refuses by name a member of the row it has no place for.
 *
 * The policy and MCP claims come from the claim tables of `src/lib/db/compatibility.ts`, one member each: `policy` from
 * `WRITE_REACH`, `READS_FILE_ACCESS_POSTURE`, `REFUSES_DENIED_FILE_ACCESS`, `SINGLE_WRITER_FILE` and
 * `READ_ROOTS_REQUIRED`, and `mcp` from `MCP_EXPOSABLE`, `MCP_STATEMENT_READ`, `MCP_METADATA_READ_CHANGES_STATE` and
 * `MCP_AGENT_CREDENTIAL_REQUIRED`. Each table is Studio's review record of its claim, which every gate reads, and a
 * member is a request, never a fact Studio believes as declared (docs/providers/CONTRACT.md, clause M-52), so the
 * declaration states each shipped engine's request as its record's row. `READ_ONLY_ENFORCED` has no member, since Studio
 * derives it from the write reach, and `connection.readsTrustMaterial`, which is no claim, is authored.
 * The claims of the connection, facets, agent and SQL text segments are written the same way: each is the row of the
 * review record docs/providers/CONTRACT.md, clause M-53, names for it.
 * Two more policy claims come from records of their own: `agentCredentialForm` from `AGENT_CREDENTIAL_FORM`, whose null
 * row, the user and password together, is written `pair`, and `maskingExemptColumns` from `MASKING_EXEMPT_COLUMNS`
 * (clauses M-58 and M-59).
 *
 * The agent overlay comes from the engine's server overlay in Studio's agent overlay registry, `engineServerOverlay`
 * (clause M-67): null where the engine speaks no statement language; otherwise its dialect, null where the overlay holds
 * none, each dialect member null where the overlay says `"unsupported"`, and its grounding override, null where the
 * engine keeps its family's. Each function is named by its slot: `catalogColumns`, `catalogRelations`, `catalogIndexes`
 * and `catalogStatistics` for the catalog read's composers, `declaredSchema`, `retryMatches`, `retryRewrite` and
 * `mapRows`, `emailShapeTest` and `digitRunShapeTest` for a profile's shape tests, `statisticsBuild`, `captureBuild` and
 * `groundingOverride`. The command flag is written as `=== true`, each profile type pattern as its source and flags, an
 * optional member the overlay leaves out null, and the capture's kind words as `{ word, kind }` entries in the record's
 * key order. The registry is no provider module, so the sentence above on provider modules stays true. The generator
 * refuses by name a member of the overlay it has no place for, the two overridable members besides grounding among
 * them until the contract states them, a plan form that is neither prefix nor session-mode, a grounding given as a
 * value, and a profile type pattern whose flags are not none, i, u or iu.
 *
 * The facets come from the engine's `ENGINE_FACETS` row, except the maintenance specs, which are the provider's own
 * statements and come from its capabilities' `maintenanceOperationSpecs` (clause M-64): one per operation of the row's
 * maintenance list, in that order, a title, description, confirmation or kinds the provider leaves out written null and
 * a preview it leaves out written false. The generator refuses by name a listed operation with no spec and a spec for an
 * operation the list does not name.
 *
 * The safeguards are no claims but the provider's own statements of what its code does, so they come from its
 * capabilities, read as the editor facts are (clause M-60): `writePaths` from `writeReach`, path by path in the order
 * of `WRITE_PATHS` (`src/lib/db/write-reach.ts`) with a proof the provider names none of written null, and every path
 * open where the provider declares no write reach, the reading Studio gives that absence; `metadataOnly` from
 * `metadataOnly`, one entry per operation in the capability's key order; and `inlineEditRefusedColumns` from
 * `inlineEditRefusedColumns`. The last two are null where the provider declares none.
 *
 * The editor facts other than the authored commit keyword, consent deadline and fence aliases come from
 * `QUERY_DIALECTS`, the editor language tables (`EDITOR_LANGUAGES` and `DIALECT_EDITORS`) and each engine's
 * capabilities. The capabilities are read as Studio reads a provider it never
 * connects, `readProviderDeclarations` with the engine's census connection (tests/helpers/census-connection.ts), so the
 * declaration states the explain format and the query dialect the provider declares before it connects. That read
 * builds every provider once, in a child process (scripts/read-engine-capabilities.ts) whose environment is
 * `CAPABILITY_READ_ENVIRONMENT`, empty, with no `.env` file loaded: a provider reads variables when it is built, and
 * one set where the generator runs, exported or in a `.env` file, never changes a declaration. The child loads each
 * provider module and logs one line per engine. The generator refuses by name, rather than write a declaration that
 * drops or misstates it: an explain format the provider's explain support contradicts, a dialect `QUERY_DIALECTS` has no row
 * for, a dialect row whose tab type is not the dialect's name, and a dialect row no engine declares.
 *
 * The editor language is the engine's query language, the Monaco language of the tab type Studio's `resolveTabType`
 * gives its capabilities, read from that tab type's `DIALECT_EDITORS` row, and that language's accent and whether it is
 * a console dialect, read from its `EDITOR_LANGUAGES` row. No tab type is written, since the dialect or the query
 * language gives it, and no console dialect id, since it is the Monaco id. A language's registration, completion
 * source and formatter, and a console's grammar and routes, stay browser code Studio's editor reads, so none of them is
 * written. The generator refuses by name a member of either row it has no place for, a language row whose `monacoId` is
 * not its key, and a console whose dialect id is not its Monaco id.
 *
 * Run: bun scripts/generate-engine-declarations.ts --write | --check [--out <directory>]
 * --write writes every declaration and removes a `.json` file for an id no longer shipped, --check exits 1 naming each
 * declaration that differs, is missing or is not a shipped id, and --out names another directory for either, resolved
 * against the working directory. Both refuse, by name, an entry of the directory that is not a `.json` file.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentOverlay,
  CatalogCapture,
  CatalogRead,
  ClausePattern,
  Editor,
  EditorLanguageFacts,
  EngineDeclaration,
  FieldName,
  GrammarFacts,
  MaintenanceSpec,
  MigrationDdl,
  NameQuote,
  PlanEstimate,
  ProfileComposition,
  ProfileTypePattern,
  QueryDialectRow,
  Safeguards,
  SqlDialect,
  SqlGenerators,
  SqlText,
  SqlWriting,
  StatementRedaction,
  StatisticsReading,
  TypeFamilies,
  TypePattern,
  WritePathEvidence,
} from "@libredb/provider-sdk/manifest";
import type { SqlGrammar } from "@libredb/provider-sdk/sql";
import { AGENT_STATEMENT_LANGUAGE } from "../src/lib/agent/agent-manifest";
import type { AgentCatalogRead, AgentPlanEstimate } from "../src/lib/agent/composed-sql-primitives";
import { engineServerOverlay } from "../src/lib/agent/languages/engines/server";
import type { AgentEngineServerDialect, Unsupported } from "../src/lib/agent/languages/pack";
import type { AgentCatalogCapture } from "../src/lib/agent/catalog-rows";
import type { AgentStatisticsReading } from "../src/lib/agent/schema-stats";
import type { AgentProfileComposition } from "../src/lib/agent/table-profile";
import {
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
  REFUSES_DENIED_FILE_ACCESS,
  SHIPPED_DATABASE_TYPES,
  SINGLE_WRITER_FILE,
  SSH_TUNNEL_REFUSAL,
  WRITE_REACH,
} from "../src/lib/db/compatibility";
import {
  AGENT_CREDENTIAL_FORM,
  CONNECTION_FIELD_DESCRIPTORS,
  SEED_AGENT_CREDENTIAL,
  SEED_ONLY_FIELD_NAMES,
} from "../src/lib/db/connection-fields";
import { EDITOR_LANGUAGES, type EditorLanguage } from "../src/lib/db/editor-language";
import type { EditorLanguageContribution } from "../src/lib/db/editor-language/types";
import { ENGINE_FACETS } from "../src/lib/db/engine-facets";
import { MIGRATION_DDL } from "../src/lib/db/migration-ddl";
import type { MigrationDdlSpec } from "../src/lib/db/migration-ddl/types";
import { type DialectSpec, QUERY_DIALECTS, type QueryDialect } from "../src/lib/db/query-dialects";
import { SQL_ENGINE_GENERATORS } from "../src/lib/db/query-generators";
import type { SqlEngineGenerators } from "../src/lib/db/query-generators/types";
import { SQL_GRAMMAR } from "../src/lib/db/sql-grammar";
import type { SqlGrammarSpec, SqlRedaction } from "../src/lib/db/sql-grammar/types";
import { SQL_WRITING } from "../src/lib/db/sql-writing";
import type { InferredKind, SqlWritingSpec } from "../src/lib/db/sql-writing/types";
import type { MaintenanceOperation, ProviderCapabilities, WritePath, WritePathReach } from "../src/lib/db/types";
import type { NonFiniteWord } from "../src/lib/non-finite";
import { DIALECT_EDITORS, type DialectEditor } from "../src/lib/editor/dialect-editors";
import { resolveTabType } from "../src/lib/editor/tab-language";
import type { DatabaseType, QueryTab } from "../src/lib/types";
import { type AuthoredMembers, authoredMembersOf, ENGINE_DECLARATIONS_DIRECTORY } from "./generate-engine-catalog";

export {
  AUTHORED_MEMBERS,
  type AuthoredMembers,
  authoredMembersOf,
  ENGINE_DECLARATIONS_DIRECTORY,
} from "./generate-engine-catalog";

/** The authored members of the committed declaration of `type`, read from the repository's declarations directory. */
function committedAuthoredMembers(type: DatabaseType): AuthoredMembers {
  const file = `${type}.json`;
  return authoredMembersOf(
    JSON.parse(readFileSync(path.join(REPO_ROOT, ENGINE_DECLARATIONS_DIRECTORY, file), "utf8")),
    file,
  );
}

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const WRITE_COMMAND = "bun run engines:generate";
const USAGE = "Usage: bun scripts/generate-engine-declarations.ts --write | --check [--out <directory>]";

/** The contract's field names, the same vocabulary the schema's `fieldName` lists. */
const FIELD_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(CONNECTION_FIELD_DESCRIPTORS),
  ...SEED_ONLY_FIELD_NAMES,
]);

/** A field name of a table as a contract field name, or a thrown error naming it where the vocabulary lacks it. */
function fieldName(name: string, type: DatabaseType): FieldName {
  if (!FIELD_NAMES.has(name)) throw new Error(`${type}: "${name}" is not a field name of the provider contract`);
  return name as FieldName;
}

/** The tables an engine's editor facts are read from, a parameter so a test can hand the generator others. */
export interface EditorTables {
  readonly dialects: Readonly<Partial<Record<QueryDialect, DialectSpec>>>;
  readonly languages: Readonly<Record<EditorLanguage, EditorLanguageContribution>>;
  readonly tabEditors: Readonly<Record<QueryTab["type"], DialectEditor>>;
}

/** Today's tables of the editor facts. */
export const EDITOR_TABLES: EditorTables = Object.freeze({
  dialects: QUERY_DIALECTS,
  languages: EDITOR_LANGUAGES,
  tabEditors: DIALECT_EDITORS,
});

/**
 * The environment the capability read runs in: none of the variables of the environment the generator runs in, so a
 * variable a provider reads when it is built (the Firestore provider declares no explain format when
 * `FIRESTORE_EMULATOR_HOST` is set) can never change a declaration, whether it was exported or loaded from a `.env`
 * file.
 */
export const CAPABILITY_READ_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({});

/** The script that reads every engine's capabilities in a child process of its own. */
const CAPABILITY_READER = path.join(import.meta.dir, "read-engine-capabilities.ts");
/** The reader as the repository names it, with `/` on every platform, for the sentence a failed read answers. */
const READER_IN_REPOSITORY = path.relative(REPO_ROOT, CAPABILITY_READER).replaceAll(path.sep, "/");

/**
 * Every shipped engine's capabilities as its provider declares them before it connects, read by
 * scripts/read-engine-capabilities.ts in a child process with `environment` as its whole environment and no `.env` file
 * loaded: each provider built once with the engine's census connection through `readProviderDeclarations`, the read
 * Studio takes of a provider it never connects. The child's output is this process's; a child that fails, such as one
 * whose provider fails to build, rejects the whole read with its exit code, after its own error.
 */
export async function readEngineCapabilities(
  environment: Readonly<Record<string, string>> = CAPABILITY_READ_ENVIRONMENT,
): Promise<Readonly<Record<DatabaseType, ProviderCapabilities>>> {
  const directory = mkdtempSync(path.join(tmpdir(), "engine-capabilities-"));
  try {
    const file = path.join(directory, "capabilities.json");
    const child = Bun.spawn([process.execPath, "--no-env-file", CAPABILITY_READER, file], {
      cwd: REPO_ROOT,
      env: { ...environment },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(`the capability read (${READER_IN_REPOSITORY}) exited with code ${exitCode}`);
    }
    // The child writes one entry per member of SHIPPED_DATABASE_TYPES, which lists every member of DatabaseType.
    return Object.freeze(JSON.parse(readFileSync(file, "utf8")) as Record<DatabaseType, ProviderCapabilities>);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The engine's query dialect with the answers of its row, or null where the provider declares none: `offersSqlExport`
 * resolved, since an absent member means offered, and a history mask written as null where the row has none. A
 * dialect `dialects` has no row for, or whose row's tab type is not the dialect's name, is a thrown error naming it.
 */
function buildDialect(
  type: DatabaseType,
  dialect: QueryDialect | undefined,
  dialects: EditorTables["dialects"],
): QueryDialectRow {
  if (dialect === undefined) return null;
  const row = Object.hasOwn(dialects, dialect) ? dialects[dialect] : undefined;
  if (row === undefined) {
    throw new Error(`${type}: the provider declares the ${dialect} dialect, which QUERY_DIALECTS has no row for`);
  }
  if (row.tabType !== dialect) {
    throw new Error(`${type}: the ${dialect} dialect's tab type "${row.tabType}" is not the dialect's name`);
  }
  return {
    name: dialect,
    offersColumnProfiling: row.offersColumnProfiling,
    offersCodeGeneration: row.offersCodeGeneration,
    offersCountQuery: row.offersCountQuery,
    offersSqlExport: row.offersSqlExport !== false,
    historyMask: row.historyMask === undefined ? null : { credentialFlags: [...row.historyMask.credentialFlags] },
  };
}

/**
 * The members of an editor language row: the data the declaration places (`monacoId`, `accent` and whether `console`
 * is present) and the browser code it leaves to Studio's editor (`register`, `completions` and `format`). A key this
 * list lacks would be dropped.
 */
const EDITOR_LANGUAGE_MEMBERS: readonly string[] = [
  "monacoId",
  "accent",
  "console",
  "register",
  "completions",
  "format",
];

/** The members of a tab type's editor row the declaration places: a key this list lacks would be dropped. */
const TAB_EDITOR_MEMBERS: readonly string[] = ["monacoId"];

/**
 * The language the engine's tabs are written and rendered in: its query language, the Monaco language of the tab type
 * `resolveTabType` gives its capabilities, read from that tab type's `DIALECT_EDITORS` row, and that language's accent
 * and whether it is a console dialect, read from its `EDITOR_LANGUAGES` row. A member of either row the declaration has
 * no place for, a language row whose `monacoId` is not its key, and a console whose dialect id is not the Monaco id, are
 * thrown errors naming the engine.
 */
function buildEditorLanguage(
  type: DatabaseType,
  capabilities: ProviderCapabilities,
  tables: EditorTables,
): EditorLanguageFacts {
  const tabType = resolveTabType(capabilities);
  const tabEditor = tables.tabEditors[tabType];
  for (const key of Object.keys(tabEditor)) {
    if (!TAB_EDITOR_MEMBERS.includes(key)) {
      throw new Error(
        `${type}: the ${tabType} tab type's editor member "${key}" has no place in the engine declaration`,
      );
    }
  }
  const { monacoId } = tabEditor;
  const language = tables.languages[monacoId];
  for (const key of Object.keys(language)) {
    if (!EDITOR_LANGUAGE_MEMBERS.includes(key)) {
      throw new Error(
        `${type}: the ${monacoId} editor language member "${key}" has no place in the engine declaration`,
      );
    }
  }
  const ids: [member: string, id: string][] = [["monacoId", language.monacoId]];
  if (language.console !== undefined) ids.push(["console dialect id", language.console.spec.id]);
  for (const [member, id] of ids) {
    if (id !== monacoId) {
      throw new Error(`${type}: the ${monacoId} editor language's ${member} is "${id}", not its Monaco id`);
    }
  }
  return {
    queryLanguage: capabilities.queryLanguage,
    monacoId,
    accent: language.accent,
    console: language.console !== undefined,
  };
}

/**
 * One engine's editor facts: its `authored` commit keyword, consent deadline and fence aliases as given, and the
 * explain format and the query dialect its provider declares before it connects. An explain format the provider's
 * explain support contradicts is a thrown error naming the engine.
 */
export function buildEditor(
  type: DatabaseType,
  capabilities: ProviderCapabilities,
  authored: AuthoredMembers["editor"],
  tables: EditorTables = EDITOR_TABLES,
): Editor {
  const { supportsExplain, explainFormat } = capabilities;
  if (supportsExplain && explainFormat === undefined) {
    throw new Error(`${type}: the provider supports explain but declares no explain format`);
  }
  if (!supportsExplain && explainFormat !== undefined) {
    throw new Error(`${type}: the provider declares an explain format but supports no explain`);
  }
  return {
    commitKeyword: authored.commitKeyword,
    consentDeadline: authored.consentDeadline,
    fenceAliases: authored.fenceAliases,
    explainFormat: explainFormat ?? null,
    dialect: buildDialect(type, capabilities.queryDialect, tables.dialects),
    language: buildEditorLanguage(type, capabilities, tables),
  };
}

/**
 * Throws an error naming the first dialect of `dialects` that no engine's capabilities declare, since every declaration
 * states only its own engine's dialect, so such a row would reach no declaration.
 */
export function refuseUndeclaredDialects(
  capabilities: Readonly<Record<DatabaseType, ProviderCapabilities>>,
  dialects: EditorTables["dialects"] = QUERY_DIALECTS,
): void {
  const declared = new Set(Object.values(capabilities).map((entry) => entry.queryDialect));
  for (const dialect of Object.keys(dialects) as QueryDialect[]) {
    if (!declared.has(dialect)) {
      throw new Error(`the ${dialect} dialect's row in QUERY_DIALECTS is declared by no engine`);
    }
  }
}

/** The members of each part of a SQL grammar row the declaration places: a key a part's list lacks would be dropped. */
const SQL_TEXT_MEMBERS = {
  spec: ["grammar", "readsSqlText", "redaction", "updateTarget", "completion"],
  grammar: [
    "hash",
    "bracket",
    "blockComment",
    "alternateQuoting",
    "doubleSlashComment",
    "backslashAlwaysEscapes",
    "tripleQuotedStrings",
    "backtickBackslashEscapes",
    "dollarTags",
    "doubleQuoteBackslashEscapes",
    "singleQuoteBackslashEscapes",
    "rawStrings",
    "hintsAreCode",
    "lineCommentBackslashContinues",
    "lineCommentEndsAtCarriageReturn",
    "script",
    "trailingLimitClauses",
    "nonNumericRowBounds",
    "confirmForms",
    "confirmCodeForms",
    "confirmFormsWhen",
    "confirmExemptForms",
    "formatterLanguage",
    "completionWords",
    "confirmConfigKeys",
    "explainExecutesWithAnalyze",
  ],
  script: ["blocks", "separatorLine", "unit", "terminatedStatements"],
  updateTarget: ["dashCommentNeedsSeparator", "extraQueryOpeners", "extraSetOperators"],
  completion: ["formatSegment", "readQuotedQualifier"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** The members of the grammar's completion words, which the declaration places. */
const COMPLETION_WORDS_MEMBERS: readonly string[] = ["keywords", "functions"];

/** The members of each entry of the grammar's confirmFormsWhen, which the declaration places. */
const CONFIRM_FORM_MEMBERS: readonly string[] = ["form", "when"];

/** The members a redaction of each kind holds, which the declaration places. */
const REDACTION_MEMBERS: Readonly<Record<SqlRedaction["kind"], readonly string[]>> = {
  sql: ["kind", "nameQuote"],
  command: ["kind", "read"],
  none: ["kind"],
};

/**
 * Throws an error naming the engine and the member where `part`, at the dotted path `at` of a SQL grammar row, has a
 * key the declaration does not write, since writing member by member would otherwise drop it. The keys are read with
 * `Object.keys`, so a key a spread carried in is read too.
 */
function refuseUnplacedSqlTextMembers(type: DatabaseType, part: object, at: string, members: readonly string[]): void {
  for (const key of Object.keys(part)) {
    if (!members.includes(key)) {
      throw new Error(`${type}: the SQL grammar member "${at}${key}" has no place in the engine declaration`);
    }
  }
}

/**
 * A trailing limit clause as the contract's pattern, or a thrown error naming the clause where its flags are not i or
 * iu.
 */
function clausePattern(pattern: RegExp, index: number, type: DatabaseType): ClausePattern {
  const { source, flags } = pattern;
  if (flags !== "i" && flags !== "iu") {
    throw new Error(
      `${type}: trailing limit clause ${index} has flags "${flags}"; the provider contract allows i or iu`,
    );
  }
  return { source, flags };
}

/**
 * The grammar facts of one engine, member by member in the order of the schema's `grammarFacts`: a fact the grammar
 * leaves out at the reading its absence has (false, an empty list, true for `dollarTags`, `postgresql` for the
 * formatter language, two empty lists for completion words), the two backslash overrides and `confirmConfigKeys` as
 * null where it is left out, each trailing limit clause as its source and flags.
 */
function buildGrammarFacts(grammar: SqlGrammar, type: DatabaseType): GrammarFacts {
  const { script } = grammar;
  return {
    hash: grammar.hash,
    bracket: grammar.bracket,
    blockComment: grammar.blockComment,
    alternateQuoting: grammar.alternateQuoting,
    doubleSlashComment: grammar.doubleSlashComment,
    backslashAlwaysEscapes: grammar.backslashAlwaysEscapes,
    tripleQuotedStrings: grammar.tripleQuotedStrings ?? false,
    backtickBackslashEscapes: grammar.backtickBackslashEscapes ?? false,
    dollarTags: grammar.dollarTags ?? true,
    doubleQuoteBackslashEscapes: grammar.doubleQuoteBackslashEscapes ?? null,
    singleQuoteBackslashEscapes: grammar.singleQuoteBackslashEscapes ?? null,
    rawStrings: grammar.rawStrings ?? false,
    hintsAreCode: grammar.hintsAreCode ?? false,
    lineCommentBackslashContinues: grammar.lineCommentBackslashContinues ?? false,
    lineCommentEndsAtCarriageReturn: grammar.lineCommentEndsAtCarriageReturn ?? false,
    script: {
      blocks: script.blocks,
      separatorLine: script.separatorLine,
      unit: script.unit,
      terminatedStatements: [...(script.terminatedStatements ?? [])],
    },
    trailingLimitClauses: grammar.trailingLimitClauses.map((pattern, index) => clausePattern(pattern, index, type)),
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
    explainExecutesWithAnalyze: grammar.explainExecutesWithAnalyze ?? false,
  };
}

/** An engine's redaction as the contract's: a command reader named by its slot, `redactionReader`. */
function buildRedaction(redaction: SqlRedaction): StatementRedaction {
  switch (redaction.kind) {
    case "sql":
      // The schema's nameQuote vocabulary holds the quote: the census admits every declaration by the schema.
      return { kind: "sql", nameQuote: redaction.nameQuote as NameQuote };
    case "command":
      return { kind: "command", reader: "redactionReader" };
    case "none":
      return { kind: "none" };
  }
}

/**
 * One engine's SQL text facts, read from its row in `SQL_GRAMMAR` (a parameter, so a test can hand the generator
 * another row): whether its text is SQL, its grammar facts, its redaction, its update target words, each set as an
 * array in its iteration order, and its completion readers, each function named by its slot. A member the declaration
 * has no place for, and a trailing limit clause whose flags are not i or iu, are thrown errors naming the engine.
 */
export function buildSqlText(type: DatabaseType, spec: SqlGrammarSpec = SQL_GRAMMAR[type]): SqlText {
  refuseUnplacedSqlTextMembers(type, spec, "", SQL_TEXT_MEMBERS.spec);
  refuseUnplacedSqlTextMembers(type, spec.grammar, "grammar.", SQL_TEXT_MEMBERS.grammar);
  refuseUnplacedSqlTextMembers(type, spec.grammar.script, "grammar.script.", SQL_TEXT_MEMBERS.script);
  refuseUnplacedSqlTextMembers(type, spec.redaction, "redaction.", REDACTION_MEMBERS[spec.redaction.kind]);
  refuseUnplacedSqlTextMembers(type, spec.updateTarget, "updateTarget.", SQL_TEXT_MEMBERS.updateTarget);
  refuseUnplacedSqlTextMembers(type, spec.completion, "completion.", SQL_TEXT_MEMBERS.completion);
  if (spec.grammar.completionWords !== undefined) {
    refuseUnplacedSqlTextMembers(
      type,
      spec.grammar.completionWords,
      "grammar.completionWords.",
      COMPLETION_WORDS_MEMBERS,
    );
  }
  for (const [index, entry] of (spec.grammar.confirmFormsWhen ?? []).entries()) {
    refuseUnplacedSqlTextMembers(type, entry, `grammar.confirmFormsWhen.${index}.`, CONFIRM_FORM_MEMBERS);
  }
  return {
    readsSqlText: spec.readsSqlText,
    grammar: buildGrammarFacts(spec.grammar, type),
    redaction: buildRedaction(spec.redaction),
    updateTarget: {
      dashCommentNeedsSeparator: spec.updateTarget.dashCommentNeedsSeparator,
      extraQueryOpeners: [...spec.updateTarget.extraQueryOpeners],
      extraSetOperators: [...spec.updateTarget.extraSetOperators],
    },
    completion: {
      formatSegment: spec.completion.formatSegment === null ? null : "formatSegment",
      readQuotedQualifier: spec.completion.readQuotedQualifier === null ? null : "readQuotedQualifier",
    },
  };
}

/** The members of each part of a SQL writing row the declaration places: a key a part's list lacks would be dropped. */
const SQL_WRITING_MEMBERS = {
  spec: [
    "escapeLiteral",
    "unescapeLiteral",
    "quoteIdentifier",
    "placeholder",
    "temporalLiteral",
    "inlineEdit",
    "export",
    "insertDocuments",
  ],
  inlineEdit: ["instantTypeNames", "exactDecimalTypeNames", "float64TypeNames", "boundEdit"],
  export: [
    "ddlTypes",
    "standsAlone",
    "bareSpelling",
    "typeVocabulary",
    "binaryLiteral",
    "nonFinite",
    "insertForm",
    "rewriteDeclared",
    "declareFromSample",
    "typedLiteral",
    "columnWriters",
    "createTableKey",
  ],
  typeVocabulary: ["bareTypeFamily", "floatType", "exactNumericType", "numericWrapper"],
  createTableKey: ["note", "clause"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** The inferred kinds, in the order of the schema's `ddlTypeSpellings` and `typeFamilies`. */
const INFERRED_KINDS: readonly InferredKind[] = ["text", "integer", "numeric", "boolean", "timestamp", "binary"];

/** NaN and the infinities, in the order of the schema's `nonFiniteLiterals`. */
const NON_FINITE_WORDS: readonly NonFiniteWord[] = ["NaN", "Infinity", "-Infinity"];

/** The flags a type pattern may carry. */
const TYPE_PATTERN_FLAGS: readonly string[] = ["", "i", "u", "iu"];

/**
 * Throws an error naming the engine and the member where `part`, at the dotted path `at` of a SQL writing row, has a
 * key the declaration does not write. The keys are read with `Object.keys`, so a key a spread carried in is read too.
 */
function refuseUnplacedSqlWritingMembers(
  type: DatabaseType,
  part: object,
  at: string,
  members: readonly string[],
): void {
  for (const key of Object.keys(part)) {
    if (!members.includes(key)) {
      throw new Error(`${type}: the SQL writing member "${at}${key}" has no place in the engine declaration`);
    }
  }
}

/** A type pattern as the contract's, or a thrown error naming the member where its flags are not none, i, u or iu. */
function typePattern(pattern: RegExp, member: string, type: DatabaseType): TypePattern {
  const { source, flags } = pattern;
  if (!TYPE_PATTERN_FLAGS.includes(flags)) {
    throw new Error(
      `${type}: the type pattern "${member}" has flags "${flags}"; the provider contract allows none, i, u or iu`,
    );
  }
  return { source, flags: flags as TypePattern["flags"] };
}

/**
 * The bare type families as six lists keyed by kind, in the schema's kind order, each in the record's key order, or a
 * thrown error naming the name whose family is not an inferred kind.
 */
function typeFamilies(family: Readonly<Record<string, InferredKind>>, type: DatabaseType): TypeFamilies {
  for (const [name, kind] of Object.entries(family)) {
    if (!INFERRED_KINDS.includes(kind)) {
      throw new Error(
        `${type}: the bare type "${name}" has the family "${kind}", which is not an inferred kind of the provider contract`,
      );
    }
  }
  const namesOf = (kind: InferredKind) =>
    Object.entries(family)
      .filter(([, of]) => of === kind)
      .map(([name]) => name);
  return {
    text: namesOf("text"),
    integer: namesOf("integer"),
    numeric: namesOf("numeric"),
    boolean: namesOf("boolean"),
    timestamp: namesOf("timestamp"),
    binary: namesOf("binary"),
  };
}

/**
 * One engine's SQL writing facts, read from its row in `SQL_WRITING` (a parameter, so a test can hand the generator
 * another row), member by member in the order of the schema's `sqlWriting`: each function named by the slot it fills
 * where the row holds one and null where it holds none, each type name set as an array in its iteration order, the
 * DDL types and the bare type families by kind, the bare spellings as entries in the record's key order, the non-finite
 * literals by word, and each type pattern as its source and flags. A member the declaration has no place for, a type
 * pattern whose flags are not none, i, u or iu, and a bare type family that is not an inferred kind are thrown errors
 * naming the engine.
 */
export function buildSqlWriting(type: DatabaseType, spec: SqlWritingSpec = SQL_WRITING[type]): SqlWriting {
  const { inlineEdit, export: facts } = spec;
  const { typeVocabulary: vocabulary, createTableKey } = facts;
  refuseUnplacedSqlWritingMembers(type, spec, "", SQL_WRITING_MEMBERS.spec);
  refuseUnplacedSqlWritingMembers(type, inlineEdit, "inlineEdit.", SQL_WRITING_MEMBERS.inlineEdit);
  refuseUnplacedSqlWritingMembers(type, facts, "export.", SQL_WRITING_MEMBERS.export);
  refuseUnplacedSqlWritingMembers(type, facts.ddlTypes, "export.ddlTypes.", INFERRED_KINDS);
  refuseUnplacedSqlWritingMembers(type, facts.nonFinite, "export.nonFinite.", NON_FINITE_WORDS);
  refuseUnplacedSqlWritingMembers(type, vocabulary, "export.typeVocabulary.", SQL_WRITING_MEMBERS.typeVocabulary);
  if (createTableKey !== undefined) {
    refuseUnplacedSqlWritingMembers(type, createTableKey, "export.createTableKey.", SQL_WRITING_MEMBERS.createTableKey);
  }
  return {
    escapeLiteral: "escapeLiteral",
    unescapeLiteral: "unescapeLiteral",
    quoteIdentifier: "quoteIdentifier",
    placeholder: spec.placeholder === null ? null : "placeholder",
    temporalLiteral: spec.temporalLiteral === null ? null : "temporalLiteral",
    inlineEdit: {
      instantTypeNames: [...inlineEdit.instantTypeNames],
      exactDecimalTypeNames: [...inlineEdit.exactDecimalTypeNames],
      float64TypeNames: inlineEdit.float64TypeNames === "all" ? "all" : [...inlineEdit.float64TypeNames],
      boundEdit: inlineEdit.boundEdit === undefined ? null : "boundEdit",
    },
    export: {
      ddlTypes: {
        text: facts.ddlTypes.text,
        integer: facts.ddlTypes.integer,
        numeric: facts.ddlTypes.numeric,
        boolean: facts.ddlTypes.boolean,
        timestamp: facts.ddlTypes.timestamp,
        binary: facts.ddlTypes.binary,
      },
      standsAlone: [...facts.standsAlone],
      bareSpelling: Object.entries(facts.bareSpelling).map(([name, spelling]) => ({ name, spelling })),
      typeVocabulary: {
        bareTypeFamily: typeFamilies(vocabulary.bareTypeFamily, type),
        floatType: typePattern(vocabulary.floatType, "floatType", type),
        exactNumericType: typePattern(vocabulary.exactNumericType, "exactNumericType", type),
        numericWrapper: typePattern(vocabulary.numericWrapper, "numericWrapper", type),
      },
      binaryLiteral: "binaryLiteral",
      nonFinite: {
        NaN: facts.nonFinite.NaN,
        Infinity: facts.nonFinite.Infinity,
        "-Infinity": facts.nonFinite["-Infinity"],
      },
      insertForm: facts.insertForm,
      rewriteDeclared: facts.rewriteDeclared === undefined ? null : "rewriteDeclared",
      declareFromSample: facts.declareFromSample === undefined ? null : "declareFromSample",
      typedLiteral: facts.typedLiteral === undefined ? null : "typedLiteral",
      columnWriters: facts.columnWriters === undefined ? null : "columnWriters",
      createTableKey:
        createTableKey === undefined ? null : { note: createTableKey.note, clause: "createTableKeyClause" },
    },
    insertDocuments: spec.insertDocuments === undefined ? null : "insertDocuments",
  };
}

/** The members of each part of a migration DDL row the declaration places: a key a part's list lacks would be dropped. */
const MIGRATION_DDL_MEMBERS = {
  refused: ["tableDdl", "refusal", "transactionWrapper", "reasons"],
  written: [
    "tableDdl",
    "transactionWrapper",
    "createTable",
    "columnDef",
    "createIndex",
    "dropIndex",
    "addForeignKey",
    "dropForeignKey",
    "addColumn",
    "dropColumn",
    "modifyColumn",
    "dropTable",
    "reasons",
  ],
  createTableRefused: ["kind", "createTableRefusal"],
  createTableWritten: ["kind", "primaryKey", "foreignKey"],
  transactionWrapper: ["begin", "commit"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/**
 * Throws an error naming the engine and the member where `part`, at the dotted path `at` of a migration DDL row, has a
 * key the declaration does not write. The keys are read with `Object.keys`, so a key a spread carried in is read too.
 */
function refuseUnplacedMigrationDdlMembers(
  type: DatabaseType,
  part: object,
  at: string,
  members: readonly string[],
): void {
  for (const key of Object.keys(part)) {
    if (!members.includes(key)) {
      throw new Error(`${type}: the migration DDL member "${at}${key}" has no place in the engine declaration`);
    }
  }
}

/**
 * Throws an error naming the engine and the member where the form `value`, read at `member` of a migration DDL row, is
 * neither refused nor written, so an unknown form is never written as the other.
 */
function refuseUnknownMigrationDdlForm(type: DatabaseType, member: string, value: string): void {
  if (value !== "refused" && value !== "written") {
    throw new Error(`${type}: the migration DDL member "${member}" is "${value}", neither refused nor written`);
  }
}

/**
 * One engine's migration DDL facts, read from its row in `MIGRATION_DDL` (a parameter, so a test can hand the generator
 * another row), in the row's form. A refused row is written with its own refusal line, transaction wrapper and reasons,
 * the wrapper written through, so a row that wraps a refusal is refused by the schema rather than dropped here. A
 * written row is written member by member in the order of the schema's `migrationDdlWritten`: the transaction wrapper
 * as `{ begin, commit }` or null, the CREATE TABLE by its kind, each function named by the slot it fills, and the
 * reasons as an array in order. A member the declaration has no place for, and a table DDL or CREATE TABLE form that is
 * neither refused nor written, are thrown errors naming the engine.
 */
export function buildMigrationDdl(type: DatabaseType, spec: MigrationDdlSpec = MIGRATION_DDL[type]): MigrationDdl {
  refuseUnknownMigrationDdlForm(type, "tableDdl", spec.tableDdl);
  if (spec.tableDdl === "refused") {
    refuseUnplacedMigrationDdlMembers(type, spec, "", MIGRATION_DDL_MEMBERS.refused);
    return {
      tableDdl: "refused",
      refusal: spec.refusal,
      transactionWrapper: spec.transactionWrapper,
      reasons: [...spec.reasons],
    };
  }
  const { createTable, transactionWrapper: wrapper } = spec;
  refuseUnplacedMigrationDdlMembers(type, spec, "", MIGRATION_DDL_MEMBERS.written);
  if (wrapper !== null) {
    refuseUnplacedMigrationDdlMembers(type, wrapper, "transactionWrapper.", MIGRATION_DDL_MEMBERS.transactionWrapper);
  }
  refuseUnknownMigrationDdlForm(type, "createTable.kind", createTable.kind);
  refuseUnplacedMigrationDdlMembers(
    type,
    createTable,
    "createTable.",
    createTable.kind === "refused"
      ? MIGRATION_DDL_MEMBERS.createTableRefused
      : MIGRATION_DDL_MEMBERS.createTableWritten,
  );
  return {
    tableDdl: "written",
    transactionWrapper: wrapper === null ? null : { begin: wrapper.begin, commit: wrapper.commit },
    createTable:
      createTable.kind === "refused"
        ? { kind: "refused", createTableRefusal: "createTableRefusal" }
        : { kind: "written", primaryKey: "createTablePrimaryKey", foreignKey: "createTableForeignKey" },
    columnDef: "columnDef",
    createIndex: "createIndex",
    dropIndex: "dropIndex",
    addForeignKey: "addForeignKey",
    dropForeignKey: "dropForeignKey",
    addColumn: "addColumn",
    dropColumn: "dropColumn",
    modifyColumn: "modifyColumn",
    dropTable: "dropTable",
    reasons: [...spec.reasons],
  };
}

/** The members of an SQL generator row the declaration places: a key this list lacks would be dropped. */
const SQL_GENERATOR_MEMBERS: readonly string[] = ["quote", "table", "select", "selectList", "countExpression"];

/** The engine's row of `SQL_ENGINE_GENERATORS`, read as an own key; undefined where it writes the shared forms. */
function sqlGeneratorRow(type: DatabaseType): SqlEngineGenerators | undefined {
  return Object.hasOwn(SQL_ENGINE_GENERATORS, type) ? SQL_ENGINE_GENERATORS[type] : undefined;
}

/**
 * One engine's SQL generator forms, read from its row in `SQL_ENGINE_GENERATORS` (a parameter, so a test can hand the
 * generator another row): null where it has none, otherwise each member in the order of the schema's `sqlGenerators`,
 * each form named by the slot it fills or null where the row leaves it out, and the count expression as the row's,
 * `COUNT(*)` where the row leaves it out. A member of the row the declaration has no place for is a thrown error naming
 * the engine.
 */
export function buildSqlGenerators(
  type: DatabaseType,
  row: SqlEngineGenerators | undefined = sqlGeneratorRow(type),
): SqlGenerators {
  if (row === undefined) return null;
  for (const key of Object.keys(row)) {
    if (!SQL_GENERATOR_MEMBERS.includes(key)) {
      throw new Error(`${type}: the SQL generator member "${key}" has no place in the engine declaration`);
    }
  }
  return {
    quote: "generatorQuote",
    table: row.table === undefined ? null : "generatorTable",
    select: row.select === undefined ? null : "generatorSelect",
    selectList: row.selectList === undefined ? null : "generatorSelectList",
    countExpression: row.countExpression ?? "COUNT(*)",
  };
}

/** The members of each part of an agent overlay the declaration places: a key a part's list lacks would be dropped. */
const AGENT_OVERLAY_MEMBERS = {
  overlay: ["dialect", "grounding"],
  dialect: ["catalogRead", "planEstimate", "profileComposition", "statistics", "catalogCapture"],
  catalogRead: ["compose", "declaredSchema", "retry", "commandShaped", "mapRows"],
  compose: ["columns", "relations", "indexes", "statistics"],
  retry: ["matches", "rewrite"],
  prefix: ["kind", "prefix"],
  sessionMode: ["kind", "mode"],
  profileComposition: ["shapeTests", "incomparableType", "uncountableType"],
  shapeTests: ["email", "digitRun"],
  statistics: ["probe", "build", "limitNote"],
  catalogCapture: ["kinds", "build", "kindWords"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/**
 * Throws an error naming the engine and the member where `part`, at the dotted path `at` of an agent overlay, has a key
 * the declaration does not write. The keys are read with `Object.keys`, so a key a spread carried in is read too.
 */
function refuseUnplacedAgentOverlayMembers(
  type: DatabaseType,
  part: object,
  at: string,
  members: readonly string[],
): void {
  for (const key of Object.keys(part)) {
    if (!members.includes(key)) {
      throw new Error(`${type}: the agent overlay member "${at}${key}" has no place in the engine declaration`);
    }
  }
}

/** A profile's type pattern as its source and flags, or a thrown error naming the pattern where its flags are not allowed. */
function profileTypePattern(pattern: RegExp, member: string, type: DatabaseType): ProfileTypePattern {
  const { source, flags } = pattern;
  if (!TYPE_PATTERN_FLAGS.includes(flags)) {
    throw new Error(`${type}: the profile type pattern ${member} has flags "${flags}", which are not none, i, u or iu`);
  }
  return { source, flags: flags as ProfileTypePattern["flags"] };
}

/** A catalog read in the declaration's form: each function named by its slot, an optional member it leaves out null. */
function catalogRead(type: DatabaseType, read: AgentCatalogRead | Unsupported): CatalogRead {
  if (read === "unsupported") return null;
  refuseUnplacedAgentOverlayMembers(type, read, "dialect.catalogRead.", AGENT_OVERLAY_MEMBERS.catalogRead);
  refuseUnplacedAgentOverlayMembers(type, read.compose, "dialect.catalogRead.compose.", AGENT_OVERLAY_MEMBERS.compose);
  if (read.retry !== undefined) {
    refuseUnplacedAgentOverlayMembers(type, read.retry, "dialect.catalogRead.retry.", AGENT_OVERLAY_MEMBERS.retry);
  }
  return {
    compose: {
      columns: "catalogColumns",
      relations: "catalogRelations",
      indexes: "catalogIndexes",
      statistics: "catalogStatistics",
    },
    declaredSchema: read.declaredSchema === undefined ? null : "declaredSchema",
    retry: read.retry === undefined ? null : { matches: "retryMatches", rewrite: "retryRewrite" },
    commandShaped: read.commandShaped === true,
    mapRows: read.mapRows === undefined ? null : "mapRows",
  };
}

/**
 * An estimating plan in the declaration's form: its prefix, or the session mode. One case per form Studio's
 * `AgentPlanEstimate` allows, so a form Studio adds fails typecheck here, and a form the type does not allow that
 * reaches the generator at run time is a thrown error naming the engine, never written as another form.
 */
function planEstimate(type: DatabaseType, estimate: AgentPlanEstimate | Unsupported): PlanEstimate {
  if (estimate === "unsupported") return null;
  switch (estimate.kind) {
    case "prefix":
      refuseUnplacedAgentOverlayMembers(type, estimate, "dialect.planEstimate.", AGENT_OVERLAY_MEMBERS.prefix);
      return { kind: "prefix", prefix: estimate.prefix };
    case "session-mode":
      refuseUnplacedAgentOverlayMembers(type, estimate, "dialect.planEstimate.", AGENT_OVERLAY_MEMBERS.sessionMode);
      return { kind: "session-mode", mode: estimate.mode };
    default: {
      const unknown: never = estimate;
      throw new Error(
        `${type}: the agent overlay member "dialect.planEstimate.kind" is "${(unknown as { kind: string }).kind}", neither prefix nor session-mode`,
      );
    }
  }
}

/** A profile composition in the declaration's form: the shape tests named by their slots, each pattern by its source and flags. */
function profileComposition(type: DatabaseType, profile: AgentProfileComposition | Unsupported): ProfileComposition {
  if (profile === "unsupported") return null;
  const at = "dialect.profileComposition.";
  refuseUnplacedAgentOverlayMembers(type, profile, at, AGENT_OVERLAY_MEMBERS.profileComposition);
  refuseUnplacedAgentOverlayMembers(type, profile.shapeTests, `${at}shapeTests.`, AGENT_OVERLAY_MEMBERS.shapeTests);
  return {
    shapeTests: { email: "emailShapeTest", digitRun: "digitRunShapeTest" },
    incomparableType: profileTypePattern(profile.incomparableType, "incomparableType", type),
    uncountableType:
      profile.uncountableType === undefined
        ? null
        : profileTypePattern(profile.uncountableType, "uncountableType", type),
  };
}

/** A statistics reading in the declaration's form: its probe, its builder named by its slot, and its note or null. */
function statisticsReading(type: DatabaseType, reading: AgentStatisticsReading | Unsupported): StatisticsReading {
  if (reading === "unsupported") return null;
  refuseUnplacedAgentOverlayMembers(type, reading, "dialect.statistics.", AGENT_OVERLAY_MEMBERS.statistics);
  return { probe: reading.probe, build: "statisticsBuild", limitNote: reading.limitNote ?? null };
}

/** A catalog capture in the declaration's form: its kinds in order, its builder named by its slot, its kind words in key order. */
function catalogCapture(type: DatabaseType, capture: AgentCatalogCapture | Unsupported): CatalogCapture {
  if (capture === "unsupported") return null;
  refuseUnplacedAgentOverlayMembers(type, capture, "dialect.catalogCapture.", AGENT_OVERLAY_MEMBERS.catalogCapture);
  return {
    kinds: [...capture.kinds],
    build: "captureBuild",
    kindWords: Object.entries(capture.kindWords).map(([word, kind]) => ({ word, kind })),
  };
}

/** An SQL dialect in the declaration's form, member by member in the order of the schema's `sqlDialect`. */
function sqlDialect(type: DatabaseType, dialect: AgentEngineServerDialect): SqlDialect {
  refuseUnplacedAgentOverlayMembers(type, dialect, "dialect.", AGENT_OVERLAY_MEMBERS.dialect);
  return {
    catalogRead: catalogRead(type, dialect.catalogRead),
    planEstimate: planEstimate(type, dialect.planEstimate),
    profileComposition: profileComposition(type, dialect.profileComposition),
    statistics: statisticsReading(type, dialect.statistics),
    catalogCapture: catalogCapture(type, dialect.catalogCapture),
  };
}

/**
 * One engine's agent overlay, read from its server overlay in Studio's agent overlay registry (`engineServerOverlay`, a
 * parameter, so a test can hand the generator another): null where the engine speaks no statement language; otherwise
 * its dialect, null where the overlay holds none, and its grounding override named by its slot, `groundingOverride`, or
 * null where the overlay leaves the family's. A member the declaration has no place for, an overlay on an engine that
 * speaks no statement language, a plan form that is neither prefix nor session-mode, a grounding given as a value
 * rather than a derivation, and a profile type pattern whose flags the contract does not allow are thrown errors naming
 * the engine.
 */
export function buildAgentOverlay(
  type: DatabaseType,
  overlay: ReturnType<typeof engineServerOverlay> = engineServerOverlay(type),
): AgentOverlay {
  if (AGENT_STATEMENT_LANGUAGE[type] === null) {
    if (Object.keys(overlay).length > 0) {
      throw new Error(
        `${type}: the engine speaks no statement language, so its agent overlay has no place in the engine declaration`,
      );
    }
    return null;
  }
  refuseUnplacedAgentOverlayMembers(type, overlay, "", AGENT_OVERLAY_MEMBERS.overlay);
  if (overlay.grounding !== undefined && typeof overlay.grounding !== "function") {
    throw new Error(
      `${type}: the agent overlay gives grounding as a value, which the declaration names only as a derivation`,
    );
  }
  return {
    dialect: overlay.dialect === undefined ? null : sqlDialect(type, overlay.dialect),
    grounding: overlay.grounding === undefined ? null : "groundingOverride",
  };
}

/** One write path's answer as the provider declares it, in the declaration's form: a proof the provider names none of null. */
function writePathEvidence(path: WritePathReach): WritePathEvidence {
  if (path.reach === "gated") return { reach: "gated", gate: { module: path.gate.module, symbol: path.gate.symbol } };
  if (path.reach === "open") return { reach: "open" };
  return {
    reach: "absent",
    proof: path.proof === undefined ? null : { module: path.proof.module, symbol: path.proof.symbol },
  };
}

/**
 * One engine's safeguards, read from its provider's capabilities: the write paths in `WRITE_PATHS` order, every path
 * open where the provider declares no write reach, the reading Studio gives that absence, and a declared write reach
 * that misses a path refused by name; the metadata-only answer as
 * one entry per operation in the capability's key order, each column in its order, or null; and the inline edit
 * refusal or null.
 */
function buildSafeguards(type: DatabaseType, capabilities: ProviderCapabilities): Safeguards {
  const { writeReach, metadataOnly, inlineEditRefusedColumns } = capabilities;
  const evidence = (path: WritePath): WritePathEvidence => {
    if (writeReach === undefined) return { reach: "open" };
    const declared: WritePathReach | undefined = writeReach[path];
    if (declared === undefined) throw new Error(`${type}: the provider declares a write reach with no ${path} path`);
    return writePathEvidence(declared);
  };
  return {
    // Written out path by path, in WRITE_PATHS order, so a path the schema and Studio disagree on fails to compile here.
    writePaths: {
      editor: evidence("editor"),
      objectEdit: evidence("objectEdit"),
      maintenance: evidence("maintenance"),
      transaction: evidence("transaction"),
    },
    metadataOnly:
      metadataOnly === undefined
        ? null
        : Object.entries(metadataOnly).map(([operation, columns]) => ({
            operation,
            columns: columns.map(({ column, kind }) => ({ column, kind })),
          })),
    inlineEditRefusedColumns:
      inlineEditRefusedColumns === undefined
        ? null
        : { type: inlineEditRefusedColumns.type, reason: inlineEditRefusedColumns.reason },
  };
}

/**
 * One engine's maintenance specs, read from its provider's capabilities: one per operation of the engine's
 * `ENGINE_FACETS` maintenance list, in that order, each member the provider leaves out written at the reading Studio
 * gives that absence, null for a title, a description, a confirmation and the kinds, and false for a preview. A listed
 * operation with no spec and a spec for an operation the list does not name are each refused by name, never dropped or
 * defaulted.
 */
function buildMaintenanceSpecs(type: DatabaseType, capabilities: ProviderCapabilities): MaintenanceSpec[] {
  const listed = ENGINE_FACETS[type].maintenance;
  const specs = capabilities.maintenanceOperationSpecs ?? {};
  for (const operation of Object.keys(specs) as MaintenanceOperation[]) {
    if (!listed.includes(operation)) {
      throw new Error(
        `${type}: the provider declares a maintenance spec for ${operation}, which its engine's maintenance facet does not list`,
      );
    }
  }
  return listed.map((operation) => {
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

/** The engine's masking exemption, `MASKING_EXEMPT_COLUMNS`'s row as its column pattern and reason, or null. */
function maskingExemption(type: DatabaseType): EngineDeclaration["policy"]["maskingExemptColumns"] {
  const row = MASKING_EXEMPT_COLUMNS[type];
  return row === null ? null : { column: row.column, reason: row.reason };
}

/**
 * One engine's declaration: its `authored` members as given, and every other member read from every table the contract
 * states for it and from its provider's capabilities.
 *
 * @throws {Error} When `authored` names another engine id than `type`, and each refusal of the members it builds.
 */
export function buildEngineDeclaration(
  type: DatabaseType,
  capabilities: ProviderCapabilities,
  authored: AuthoredMembers,
): EngineDeclaration {
  if (authored.id !== type) {
    throw new Error(`${type}: the authored members given name the engine id ${JSON.stringify(authored.id)}`);
  }
  const credential = SEED_AGENT_CREDENTIAL[type];
  const sshRefusal = SSH_TUNNEL_REFUSAL[type];
  const facets = ENGINE_FACETS[type];
  return {
    id: type,
    displayName: authored.displayName,
    location: authored.location,
    connection: {
      fields: authored.connection.fields,
      defaults: authored.connection.defaults,
      seedOnly: authored.connection.seedOnly,
      refused: authored.connection.refused,
      connectionString: authored.connection.connectionString,
      tls: authored.connection.tls,
      readsTrustMaterial: authored.connection.readsTrustMaterial,
      sshTunnel: sshRefusal === null ? { offered: true } : { offered: false, refusal: sshRefusal },
      hostPathFields: [...HOST_PATH_FIELDS[type]],
      opensLocalFile: OPENS_LOCAL_FILE[type],
      serverLevelWithoutDatabase: OPENS_SERVER_LEVEL_WITHOUT_DATABASE[type],
      agentCredential:
        credential === null
          ? null
          : { form: credential.form, supersededBy: credential.supersededBy.map((field) => fieldName(field, type)) },
      dialog: authored.connection.dialog,
      hostUriSchemes: authored.connection.hostUriSchemes,
      credentialWarnings: authored.connection.credentialWarnings,
      fieldRules: authored.connection.fieldRules,
      hostHint: authored.connection.hostHint,
      hostIdentity: authored.connection.hostIdentity,
      import: authored.connection.import,
      connectBudgetMs: authored.connection.connectBudgetMs,
    },
    facets: {
      // Written out panel by panel, in MONITORING_PANELS order, so every declaration lists them alike and a panel the
      // schema and the row disagree on fails to compile here.
      monitoring: {
        overview: facets.monitoring.overview,
        performance: facets.monitoring.performance,
        slowQueries: facets.monitoring.slowQueries,
        activeSessions: facets.monitoring.activeSessions,
        tables: facets.monitoring.tables,
        indexes: facets.monitoring.indexes,
        storage: facets.monitoring.storage,
      },
      maintenance: [...facets.maintenance],
      maintenanceSpecs: buildMaintenanceSpecs(type, capabilities),
      agentReadings: [...facets.agentReadings],
    },
    agent: { statementLanguage: AGENT_STATEMENT_LANGUAGE[type], overlay: buildAgentOverlay(type) },
    editor: buildEditor(type, capabilities, authored.editor),
    sqlText: buildSqlText(type),
    sqlWriting: buildSqlWriting(type),
    migrationDdl: buildMigrationDdl(type),
    sqlGenerators: buildSqlGenerators(type),
    policy: {
      writeReach: WRITE_REACH[type],
      readsFileAccessPosture: READS_FILE_ACCESS_POSTURE[type],
      deniedFileAccessRefusal: REFUSES_DENIED_FILE_ACCESS[type],
      singleWriterFile: SINGLE_WRITER_FILE[type],
      readRootsRequired: READ_ROOTS_REQUIRED[type],
      agentCredentialForm: AGENT_CREDENTIAL_FORM[type] ?? "pair",
      maskingExemptColumns: maskingExemption(type),
    },
    mcp: {
      exposable: MCP_EXPOSABLE[type],
      statementRead: MCP_STATEMENT_READ[type],
      metadataReadChangesState: MCP_METADATA_READ_CHANGES_STATE[type],
      agentCredentialRequired: MCP_AGENT_CREDENTIAL_REQUIRED[type],
    },
    safeguards: buildSafeguards(type, capabilities),
  };
}

/** A declaration's bytes: two-space JSON and a final newline. */
export function renderEngineDeclaration(declaration: EngineDeclaration): string {
  return `${JSON.stringify(declaration, null, 2)}\n`;
}

/**
 * What is wrong with a declarations directory holding `entries` for the shipped `types`: each declaration missing, in
 * type order, then each entry, sorted, that is a `.json` file for no shipped id or not a `.json` file at all.
 */
export function declarationDirectoryProblems(entries: readonly string[], types: readonly DatabaseType[]): string[] {
  const expected = new Set(types.map((type) => `${type}.json`));
  const present = new Set(entries);
  const problems = types.filter((type) => !present.has(`${type}.json`)).map((type) => `${type}.json is missing`);
  for (const entry of [...entries].sort()) {
    if (expected.has(entry)) continue;
    problems.push(entry.endsWith(".json") ? `${entry} declares no shipped type-id` : `${entry} is not a declaration`);
  }
  return problems;
}

/** The directory's entries, or none when it does not exist yet. */
function entriesOf(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * The command line, exactly `--write` or `--check`, optionally followed by `--out <directory>`; null for anything
 * else, which the command refuses with its usage line, so a mistyped flag never rewrites the committed declarations.
 */
function parseArguments(argv: readonly string[]): { mode: "--write" | "--check"; out: string | undefined } | null {
  const [mode, flag, directory, ...rest] = argv;
  if (mode !== "--write" && mode !== "--check") return null;
  if (flag === undefined) return { mode, out: undefined };
  if (flag !== "--out" || directory === undefined || directory.startsWith("--") || rest.length > 0) return null;
  return { mode, out: directory };
}

/**
 * The command: the usage refusal and `--write`'s refusal of a directory holding an entry it does not own answer before
 * any provider is built; then every engine's capabilities are read, every dialect row is held to an engine that
 * declares it, and every declaration is built.
 */
async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArguments(argv);
  if (parsed === null) {
    console.error(USAGE);
    return 2;
  }
  const { mode, out } = parsed;
  const directory = out === undefined ? path.join(REPO_ROOT, ENGINE_DECLARATIONS_DIRECTORY) : path.resolve(out);
  const entries = entriesOf(directory);

  const foreign = entries.filter((entry) => !entry.endsWith(".json")).sort();
  if (mode === "--write" && foreign.length > 0) {
    console.error(
      `${directory} holds entries the generator does not own, so nothing was written:\n${foreign.map((entry) => `  ${entry} is not a declaration`).join("\n")}`,
    );
    return 1;
  }

  const capabilities = await readEngineCapabilities();
  refuseUndeclaredDialects(capabilities);
  const declarations = new Map(
    SHIPPED_DATABASE_TYPES.map((type) => [
      `${type}.json`,
      renderEngineDeclaration(buildEngineDeclaration(type, capabilities[type], committedAuthoredMembers(type))),
    ]),
  );

  if (mode === "--check") {
    const problems = declarationDirectoryProblems(entries, SHIPPED_DATABASE_TYPES);
    for (const [file, text] of declarations) {
      if (entries.includes(file) && readFileSync(path.join(directory, file), "utf8") !== text) {
        problems.push(`${file} differs`);
      }
    }
    if (problems.length > 0) {
      console.error(
        `${directory} is not what the per-engine tables build:\n${problems.map((p) => `  ${p}`).join("\n")}`,
      );
      console.error(`run: ${WRITE_COMMAND}`);
      return 1;
    }
    console.log(`${directory} is up to date`);
    return 0;
  }

  mkdirSync(directory, { recursive: true });
  for (const entry of entries) {
    if (!declarations.has(entry)) rmSync(path.join(directory, entry));
  }
  for (const [file, text] of declarations) writeFileSync(path.join(directory, file), text);
  console.log(`Wrote ${declarations.size} declarations to ${directory}`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
