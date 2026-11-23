#!/usr/bin/env bun
/**
 * Writes src/lib/db/engine-declarations/<type-id>.json, one engine declaration per shipped type-id, from today's
 * per-engine tables and from what each engine's provider declares before it connects (docs/providers/CONTRACT.md,
 * clause M-15).
 *
 * Each file is a `#/$defs/engineDeclaration` of the provider manifest schema
 * (packages/provider-sdk/src/manifest/manifest.schema.json): the engine's identity, its connection facts, its facets,
 * the statement language agent mode sends it and its editor facts that are data. A full manifest also states the
 * package's runtime and the products it was measured against, facts no provider in `src/lib/db/providers/` has yet, so
 * they are written when a provider moves into a package of its own, from this declaration.
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
  ConnectionDialog,
  ConnectionStringOffer,
  CredentialWarning as ManifestCredentialWarning,
  Editor,
  EngineDeclaration,
  FieldName,
  FieldRule,
  PlaceableFieldName,
  QueryDialectRow,
  SelectFieldName,
} from "@libredb/provider-sdk/manifest";
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
import { type DialectSpec, QUERY_DIALECTS, type QueryDialect } from "../src/lib/db/query-dialects";
import type { ProviderCapabilities } from "../src/lib/db/types";
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
