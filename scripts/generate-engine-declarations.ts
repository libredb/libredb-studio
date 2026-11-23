#!/usr/bin/env bun
/**
 * Writes src/lib/db/engine-declarations/<type-id>.json, one engine declaration per shipped type-id, from today's
 * per-engine tables and from what each engine's provider declares before it connects (docs/providers/CONTRACT.md,
 * clause M-15).
 *
 * Each file is a `#/$defs/engineDeclaration` of the provider manifest schema
 * (packages/provider-sdk/src/manifest/manifest.schema.json): the engine's identity, its connection facts, its facets,
 * the statement language agent mode sends it, its editor facts that are data, its SQL text facts, its SQL writing facts,
 * its migration DDL facts and its SQL generator forms. A full manifest also states the package's runtime and the products it was measured
 * against, facts no provider in `src/lib/db/providers/` has yet, so they are written when a provider moves into a package
 * of its own, from this declaration.
 *
 * The files are committed and never edited by hand, so a change to any table they come from lands with its declaration
 * diff. tests/unit/db/engine-declarations.test.ts rebuilds each in memory and fails on any byte of difference, holds
 * each to the schema, and reads each back to every table with read-back functions of its own.
 *
 * A refusal sentence the tables hold as a function becomes a template: the function is called with the placeholder
 * itself (`{field}`, or `{id}` and `{type}`), so the template is the sentence with each value's place marked, and the
 * census renders it back for every field.
 *
 * Any other function a table holds is named, never carried, and named by the slot it fills, one convention for every
 * engine: `<field>Check` for a field rule's check (`hostCheck`), `hostHint` and `hostIdentity` for the Host text
 * readers, `importer` for the connection import's parser, `urlTls` for the connection string's URL TLS reader,
 * `pasteReader` for its paste reader (one name for the reader's claims, names and parse) and `seedCheck` for its seed
 * load check. The name is read from where the function sits, never from the function itself, so this script imports no
 * provider module directly and reads no function's `name`; the census resolves each name with a table of its own and
 * holds it, by identity, to the function the connection form or the connection string row holds.
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
 * The editor facts come from `EXECUTION_UI`, the fence tag tables (`ALIAS_ENGINES` and `QUERY_FENCE_ALIASES`),
 * `QUERY_DIALECTS` and each engine's capabilities. The capabilities are read as Studio reads a provider it never
 * connects, `readProviderDeclarations` with the engine's census connection (tests/helpers/census-connection.ts), so the
 * declaration states the explain format and the query dialect the provider declares before it connects. That read
 * builds every provider once, in a child process (scripts/read-engine-capabilities.ts) whose environment is
 * `CAPABILITY_READ_ENVIRONMENT`, empty, with no `.env` file loaded: a provider reads variables when it is built, and
 * one set where the generator runs, exported or in a `.env` file, never changes a declaration. The child loads each
 * provider module and logs one line per engine. The generator refuses by name, rather than write a declaration that
 * drops or misstates it: an explain format the provider's explain support contradicts, a dialect `QUERY_DIALECTS` has no row
 * for, a dialect row whose tab type is not the dialect's name, a dialect row no engine declares, and a fence alias that
 * is not a query fence tag.
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
  BoundedPattern,
  ClausePattern,
  ConnectionDialog,
  ConnectionStringOffer,
  CredentialWarning as ManifestCredentialWarning,
  Editor,
  EngineDeclaration,
  FieldName,
  FieldRule,
  GrammarFacts,
  MigrationDdl,
  NameQuote,
  PlaceableFieldName,
  QueryDialectRow,
  SelectFieldName,
  SqlGenerators,
  SqlText,
  SqlWriting,
  StatementRedaction,
  TypeFamilies,
  TypePattern,
} from "@libredb/provider-sdk/manifest";
import type { SqlGrammar } from "@libredb/provider-sdk/sql";
import { AGENT_STATEMENT_LANGUAGE } from "../src/lib/agent/agent-manifest";
import {
  CONNECTION_FORM_URI_MODE,
  CONNECTION_STRING_ACCEPTED,
  HOST_PATH_FIELDS,
  isExternalDatabaseType,
  OPENS_LOCAL_FILE,
  OPENS_SERVER_LEVEL_WITHOUT_DATABASE,
  SHIPPED_DATABASE_TYPES,
  SSH_TUNNEL_REFUSAL,
} from "../src/lib/db/compatibility";
import {
  CONNECTION_FIELD_DESCRIPTORS,
  CONNECTION_FIELDS,
  type ConnectionField,
  PLACEABLE_FIELDS,
  type PlaceableField,
  REFUSED_CONNECTION_FIELDS,
  SEED_AGENT_CREDENTIAL,
  SEED_ONLY_FIELD_NAMES,
  SEED_ONLY_FIELDS,
} from "../src/lib/db/connection-fields";
import { CONNECTION_FORM, type ConnectionFormSpec, offersSslPanel } from "../src/lib/db/connection-form";
import { CONNECTION_STRING } from "../src/lib/db/connection-string";
import { CREDENTIAL_WARNINGS } from "../src/lib/db/credential-warnings";
import { ENGINE_FACETS } from "../src/lib/db/engine-facets";
import { EXECUTION_UI } from "../src/lib/db/execution-ui";
import type { ExecutionUiSpec } from "../src/lib/db/execution-ui/types";
import { MIGRATION_DDL } from "../src/lib/db/migration-ddl";
import type { MigrationDdlSpec } from "../src/lib/db/migration-ddl/types";
import { type DialectSpec, QUERY_DIALECTS, type QueryDialect } from "../src/lib/db/query-dialects";
import { SQL_ENGINE_GENERATORS } from "../src/lib/db/query-generators";
import type { SqlEngineGenerators } from "../src/lib/db/query-generators/types";
import { SQL_GRAMMAR } from "../src/lib/db/sql-grammar";
import type { SqlGrammarSpec, SqlRedaction } from "../src/lib/db/sql-grammar/types";
import { SQL_WRITING } from "../src/lib/db/sql-writing";
import type { InferredKind, SqlWritingSpec } from "../src/lib/db/sql-writing/types";
import type { ProviderCapabilities } from "../src/lib/db/types";
import type { NonFiniteWord } from "../src/lib/non-finite";
import { ALIAS_ENGINES, QUERY_FENCE_ALIASES } from "../src/lib/sql/fence-tags";
import type { DatabaseType } from "../src/lib/types";

/** The declarations' directory in the repository. */
export const ENGINE_DECLARATIONS_DIRECTORY = "src/lib/db/engine-declarations";

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

/** A placeable field of an engine's form as the contract's placeable name. */
function isPlaceable(field: ConnectionField): field is PlaceableField & PlaceableFieldName {
  return (PLACEABLE_FIELDS as readonly string[]).includes(field);
}

/** A field an engine's form declares choices for, as a select field name, or a thrown error naming it where it is not. */
function selectField(field: ConnectionField, type: DatabaseType): SelectFieldName {
  const descriptor = CONNECTION_FIELD_DESCRIPTORS[field];
  if (descriptor.slot !== "body" || descriptor.control.kind !== "select") {
    throw new Error(`${type}: "${field}" has fieldOptions but the dialog does not draw it as a select`);
  }
  return field as SelectFieldName;
}

/** A per-field record of an engine's form, which the generator walks in the engine's `fields` order. */
type FieldRecordName =
  | "fieldLabels"
  | "fieldHints"
  | "fieldPlaceholders"
  | "fieldPlacement"
  | "fieldOptions"
  | "fieldShownWhen"
  | "fieldDefaults"
  | "fieldRules";

/**
 * Throws an error naming the engine, the record and the field where one of `records` has an entry for a field the
 * engine does not list, since walking `fields` would otherwise drop that entry from the declaration.
 */
function refuseUnlistedFields(
  form: ConnectionFormSpec,
  records: readonly FieldRecordName[],
  fields: readonly ConnectionField[],
  type: DatabaseType,
): void {
  for (const record of records) {
    for (const field of Object.keys(form[record] ?? {})) {
      if (!(fields as readonly string[]).includes(field)) {
        throw new Error(`${type}: the ${record} entry for "${field}" names a field the engine does not list`);
      }
    }
  }
}

/**
 * How the dialog presents one engine's fields: each per-field record of its form as a list of entries naming their
 * field, in `fields` order, empty where the form declares none. An entry for a field the engine does not list is a
 * thrown error naming the engine, the record and the field.
 */
export function buildDialog(
  form: ConnectionFormSpec,
  fields: readonly ConnectionField[],
  type: DatabaseType,
): ConnectionDialog {
  refuseUnlistedFields(
    form,
    [
      "fieldLabels",
      "fieldHints",
      "fieldPlaceholders",
      "fieldPlacement",
      "fieldOptions",
      "fieldShownWhen",
      "fieldDefaults",
    ],
    fields,
    type,
  );
  const textEntries = (record: Partial<Record<ConnectionField, string>> | undefined) =>
    fields.flatMap((field) => {
      const text = record?.[field];
      return text === undefined ? [] : [{ field, text }];
    });
  return {
    order: form.dialogOrder === undefined ? null : [...form.dialogOrder],
    labels: textEntries(form.fieldLabels),
    hints: textEntries(form.fieldHints),
    placeholders: textEntries(form.fieldPlaceholders),
    placement: fields.filter(isPlaceable).flatMap((field) => {
      const where = form.fieldPlacement?.[field];
      return where === undefined ? [] : [{ field, where }];
    }),
    options: fields.flatMap((field) => {
      const choices = form.fieldOptions?.[field];
      return choices === undefined
        ? []
        : [{ field: selectField(field, type), choices: choices.map(({ value, label }) => ({ value, label })) }];
    }),
    shownWhen: fields.flatMap((field) => {
      const condition = form.fieldShownWhen?.[field];
      return condition === undefined ? [] : [{ field, when: { field: condition.field, equals: condition.equals } }];
    }),
    absentValues: fields.flatMap((field) => {
      const value = form.fieldDefaults?.[field];
      return value === undefined ? [] : [{ field, value }];
    }),
  };
}

/** A field rule's pattern flags as the contract's flags, or a thrown error naming the rule where they are not. */
function patternFlags(flags: string, field: ConnectionField, type: DatabaseType): BoundedPattern["flags"] {
  if (flags !== "" && flags !== "u") {
    throw new Error(
      `${type}: the ${field} rule's pattern has flags "${flags}"; the provider contract allows none or u`,
    );
  }
  return flags;
}

/**
 * One engine's field rules, one entry per field its form declares a rule for, in `fields` order: each pattern as its
 * source and flags, and each check named by its slot, `<field>Check`. A rule for a field the engine does not list is
 * a thrown error naming the engine and the field, since walking `fields` would otherwise drop it from the declaration.
 */
export function buildFieldRules(
  form: ConnectionFormSpec,
  fields: readonly ConnectionField[],
  type: DatabaseType,
): FieldRule[] {
  refuseUnlistedFields(form, ["fieldRules"], fields, type);
  return fields.flatMap((field) => {
    const rule = form.fieldRules?.[field];
    if (rule === undefined) return [];
    return [
      {
        field,
        required: rule.required ?? null,
        format:
          rule.format === undefined
            ? null
            : {
                pattern: {
                  source: rule.format.pattern.source,
                  flags: patternFlags(rule.format.pattern.flags, field, type),
                },
                sentence: rule.format.sentence,
              },
        charRange:
          rule.charRange === undefined
            ? null
            : { min: rule.charRange.min, max: rule.charRange.max, sentence: rule.charRange.sentence },
        check: rule.check === undefined ? null : `${field}Check`,
      },
    ];
  });
}

/**
 * One engine's connection string: what the provider accepts and the dialog offers, then its row in `CONNECTION_STRING`,
 * the scheme as written, the paste's catch-all flag and formats in order, and each function named by its slot.
 */
function buildConnectionString(type: DatabaseType): ConnectionStringOffer {
  const row = CONNECTION_STRING[type];
  return {
    accepted: CONNECTION_STRING_ACCEPTED[type],
    dialogOffersUri: CONNECTION_FORM_URI_MODE[type],
    scheme: row.scheme,
    urlTls: row.readTls === null ? null : "urlTls",
    paste:
      row.paste === null
        ? null
        : { reader: "pasteReader", catchAll: row.paste.catchAll, formats: [...row.paste.formats] },
    seedCheck: row.validateSeed === null ? null : "seedCheck",
  };
}

/**
 * The engine's credential warnings, read from `CREDENTIAL_WARNINGS` rather than the form's getter over it, so the
 * declaration names the record it comes from; each written member by member, so every declaration orders them alike.
 */
function buildCredentialWarnings(type: DatabaseType): ManifestCredentialWarning[] {
  return (CREDENTIAL_WARNINGS[type] ?? []).map((warning) => {
    switch (warning.kind) {
      case "pair":
        return { kind: warning.kind, user: warning.user, password: warning.password, message: warning.message };
      case "jwt":
        return { kind: warning.kind, noExp: warning.noExp, access: [...warning.access], message: warning.message };
      case "no-secret":
        return { kind: warning.kind, message: warning.message };
    }
  });
}

/** The tables an engine's editor facts are read from, a parameter so a test can hand the generator others. */
export interface EditorTables {
  readonly executionUi: Readonly<Record<DatabaseType, ExecutionUiSpec>>;
  readonly aliasEngines: Readonly<Record<string, DatabaseType>>;
  readonly queryAliases: ReadonlySet<string>;
  readonly dialects: Readonly<Partial<Record<QueryDialect, DialectSpec>>>;
}

/** Today's tables of the editor facts. */
export const EDITOR_TABLES: EditorTables = Object.freeze({
  executionUi: EXECUTION_UI,
  aliasEngines: ALIAS_ENGINES,
  queryAliases: QUERY_FENCE_ALIASES,
  dialects: QUERY_DIALECTS,
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
 * One engine's editor facts: its `EXECUTION_UI` row member by member, the aliases `ALIAS_ENGINES` maps to it in that
 * record's order, and the explain format and the query dialect its provider declares before it connects. An explain
 * format the provider's explain support contradicts, and an alias that is not a query fence tag, are thrown errors
 * naming the engine.
 */
export function buildEditor(
  type: DatabaseType,
  capabilities: ProviderCapabilities,
  tables: EditorTables = EDITOR_TABLES,
): Editor {
  const { commitKeyword, consentDeadline } = tables.executionUi[type];
  const { supportsExplain, explainFormat } = capabilities;
  if (supportsExplain && explainFormat === undefined) {
    throw new Error(`${type}: the provider supports explain but declares no explain format`);
  }
  if (!supportsExplain && explainFormat !== undefined) {
    throw new Error(`${type}: the provider declares an explain format but supports no explain`);
  }
  const fenceAliases = Object.keys(tables.aliasEngines).filter((alias) => tables.aliasEngines[alias] === type);
  for (const alias of fenceAliases) {
    if (!tables.queryAliases.has(alias)) {
      throw new Error(`${type}: the fence alias "${alias}" names the engine but is not a query fence tag`);
    }
  }
  return {
    commitKeyword,
    consentDeadline:
      consentDeadline === null ? null : { chip: consentDeadline.chip, sentence: consentDeadline.sentence },
    fenceAliases,
    explainFormat: explainFormat ?? null,
    dialect: buildDialect(type, capabilities.queryDialect, tables.dialects),
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

/** One engine's declaration, read from every table the contract states for it and from its provider's capabilities. */
export function buildEngineDeclaration(type: DatabaseType, capabilities: ProviderCapabilities): EngineDeclaration {
  const form = CONNECTION_FORM[type];
  const seedOnly = SEED_ONLY_FIELDS[type];
  const credential = SEED_AGENT_CREDENTIAL[type];
  const sshRefusal = SSH_TUNNEL_REFUSAL[type];
  const facets = ENGINE_FACETS[type];
  const defaults: { port?: number; host?: string } = {};
  if (form.defaultPort !== "") defaults.port = Number(form.defaultPort);
  if (form.defaultHost !== undefined) defaults.host = form.defaultHost;
  return {
    id: type,
    displayName: form.label,
    location: isExternalDatabaseType(type) ? "external" : "embedded",
    connection: {
      fields: [...CONNECTION_FIELDS[type]],
      defaults,
      seedOnly:
        seedOnly === null
          ? null
          : {
              fields: seedOnly.fields.map((field) => fieldName(field, type)),
              scope: seedOnly.kind,
              refusal: seedOnly.refusal("{field}"),
              projectionRefusal:
                seedOnly.projectionRefusal === null ? null : seedOnly.projectionRefusal("{id}", "{type}"),
            },
      refused: Object.entries(REFUSED_CONNECTION_FIELDS[type]).map(([field, refusal]) => ({
        field: fieldName(field, type),
        refusal,
      })),
      connectionString: buildConnectionString(type),
      tls: offersSslPanel(type) ? "offered" : "not-offered",
      sshTunnel: sshRefusal === null ? { offered: true } : { offered: false, refusal: sshRefusal },
      hostPathFields: [...HOST_PATH_FIELDS[type]],
      opensLocalFile: OPENS_LOCAL_FILE[type],
      serverLevelWithoutDatabase: OPENS_SERVER_LEVEL_WITHOUT_DATABASE[type],
      agentCredential:
        credential === null
          ? null
          : { form: credential.form, supersededBy: credential.supersededBy.map((field) => fieldName(field, type)) },
      dialog: buildDialog(form, CONNECTION_FIELDS[type], type),
      hostUriSchemes: [...(form.hostAcceptsUri ?? [])],
      credentialWarnings: buildCredentialWarnings(type),
      fieldRules: buildFieldRules(form, CONNECTION_FIELDS[type], type),
      hostHint: form.hostHint === undefined ? null : "hostHint",
      hostIdentity: form.hostIdentity === undefined ? null : "hostIdentity",
      import: form.connectionImport === undefined ? null : { label: form.connectionImport.label, importer: "importer" },
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
      agentReadings: [...facets.agentReadings],
    },
    agent: { statementLanguage: AGENT_STATEMENT_LANGUAGE[type] },
    editor: buildEditor(type, capabilities),
    sqlText: buildSqlText(type),
    sqlWriting: buildSqlWriting(type),
    migrationDdl: buildMigrationDdl(type),
    sqlGenerators: buildSqlGenerators(type),
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
      renderEngineDeclaration(buildEngineDeclaration(type, capabilities[type])),
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
