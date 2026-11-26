#!/usr/bin/env bun
/**
 * Writes Studio's projections of the committed engine declarations: src/lib/db/engine-catalog/catalog.generated.ts,
 * the engine catalog (docs/providers/CONTRACT.md, clause M-70); the data-only connection tables (clause M-71), in
 * two modules: src/lib/db/engine-catalog/connection.generated.ts, the fields, seed-only fields, refused fields and
 * credential warnings, and src/lib/db/engine-catalog/connection-flags.generated.ts, the three yes or no answers
 * src/lib/db/compatibility.ts reads, so that module's readers load the three records and never the other four;
 * src/lib/db/engine-catalog/connection-form.generated.ts, the connection forms (clause M-72), which only
 * src/lib/db/connection-form.ts reads, so no reader of the connection tables loads them; and
 * src/lib/db/engine-catalog/connection-string.generated.ts, the connection strings (clause M-74), which only
 * src/lib/db/connection-string/index.ts reads, so neither the paste parser nor the seed loader loads the forms; and
 * src/lib/db/engine-catalog/editor.generated.ts, each engine's execution UI and the fence aliases (clause M-75), which
 * src/lib/db/execution-ui/index.ts and src/lib/sql/fence-tags.ts read, so no connection reader loads them; and
 * src/lib/db/engine-catalog/query-editor.generated.ts, the query dialects, the tab type editors and the editor languages
 * (clause M-77), which src/lib/db/query-dialects.ts, src/lib/editor/dialect-editors.ts and
 * src/lib/db/editor-language/index.ts read, so neither the server routes that read a dialect row nor the execution UI's
 * readers load another's records; and src/lib/db/engine-catalog/sql-text.generated.ts, each engine's SQL text (clause
 * M-78), which only src/lib/db/sql-grammar/index.ts reads, so no other module's readers load its grammar data; and
 * src/lib/db/engine-catalog/sql-writing.generated.ts, each engine's SQL writing (clause M-79), which only
 * src/lib/db/sql-writing/index.ts reads, so no grammar reader loads the export's type vocabulary; and
 * src/lib/db/engine-catalog/migration-ddl.generated.ts, each engine's migration DDL (clause M-80), which only
 * src/lib/db/migration-ddl/index.ts reads, so only the schema diff loads it; and
 * src/lib/db/engine-catalog/sql-generators.generated.ts, each SQL engine's generator forms (clause M-81), which only
 * src/lib/db/query-generators/index.ts reads, so the schema diff never loads them; and
 * src/lib/db/engine-catalog/claims.generated.ts, each engine's policy, MCP, connection and agent mode claim requests
 * (clauses M-82 and M-83), which only src/lib/db/claim-grants.ts reads, so no gate reads a request but through
 * Studio's grant of it.
 *
 * Admission happens here, once for every module, in `--check`: every `.json` file of src/lib/db/engine-declarations is
 * parsed and admitted through the SDK's `compileManifestValidator`, which checks the SHA-256 of the schema's bytes
 * before it compiles them, and each module is held to the projection of the admitted set with `projectCatalog`,
 * `projectConnectionTables`, `projectConnectionForms`, `projectConnectionStrings`, `projectEditorFacts`,
 * `projectQueryEditorFacts`, `projectSqlText`, `projectSqlWriting`, `projectMigrationDdl`, `projectSqlGenerators` and
 * `projectClaimRequests` (src/lib/db/engine-catalog/projection.ts).
 * `--write` projects each file's authored members, `AUTHORED_MEMBERS`, without admitting the whole file: a file whose
 * authored members just changed still holds the members the declaration generator wrote from the previous ones, so it
 * is admitted only once that generator has rewritten the rest. The command
 * refuses, by name, an entry that is not a `.json` file, a file that is not JSON, and a declaration whose `id` is not
 * its file name; `--write` a file that lacks an authored member, `--check` a declaration the schema refuses, with the
 * validator's refusal sentences; the projections refuse two declarations of one id, the editor facts a fence alias two
 * declarations state or one equal to another declaration's engine id, and the query editor facts a dialect, a tab type
 * or an editor language two declarations state differently, so either mode exits 1 naming it before any module is
 * written. Studio's runtime reads no declaration file: the browser cannot compile the schema under Studio's content
 * security policy, which allows no `eval`, and the published library and the standalone server carry no schema file, so
 * every reader reads a generated module, which tests/unit/db/engine-catalog.test.ts holds byte for byte to what this
 * command renders.
 *
 * Each module holds frozen records keyed in ascending id order and typed as records over `DatabaseType`, so a member
 * of the union with no declaration fails the typecheck at the record; the query editor module's records are typed over
 * the query dialects, the tab types and the Monaco languages instead. The connection and editor modules are laid out
 * as the repository's formatter lays them out: a value that fits within the line width stays on one line, one that
 * does not breaks one element or member per line, and a member whose string does not fit puts the string on the next
 * line. A string is written in the formatter's quotes, a backslash doubled and a printable character outside ASCII as
 * itself, a member's key bare where it is an identifier and in the formatter's quotes where it is not (`graph-cypher`),
 * and a number is an integer written as its decimal text. A line feed is written as its escape, `\n`, since the
 * schema's comment lines, an SQL writing note, end each line with one; any other control character, and another
 * number, is refused by name.
 *
 * `bun run engines:generate` runs `--write` before scripts/generate-engine-declarations.ts and `--check` after it. The
 * declaration generator builds every provider through the factory, which builds only an engine the catalog holds, so
 * the projections come first; they read only the members a declaration authors, which the declaration generator writes
 * back unchanged, so one run is exact; and `--check` then admits the whole written set, so the run exits 1 with the
 * validator's refusal sentences when the authored members leave the declaration inconsistent, such as a placeable field
 * with no placement in the authored dialog, or when they and Studio's tables still disagree, such as a host path field
 * Studio's record lists that the authored seed-only fields no longer hold. A function name Studio holds no function for
 * fails the run earlier, at the declaration generator: it loads the connection form, the connection string index, the
 * SQL grammar, the SQL writing, the migration DDL and the query generators, which compose every engine from the modules
 * `--write` just wrote and refuse such a name by name, and it binds each engine's authored migration DDL and SQL
 * generator forms through Studio's tables itself.
 *
 * Run: bun scripts/generate-engine-catalog.ts --write | --check [--out <directory>]
 * --write writes every module, --check exits 1 naming each module that is missing or is not what the declarations
 * project, and --out names another directory for either, resolved against the working directory, in which each module
 * is its file name.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileManifestValidator, type EngineDeclaration, refusalSentence } from "@libredb/provider-sdk/manifest";
import {
  type AuthoredDeclaration,
  type ClaimRequests,
  type ConnectionForms,
  type ConnectionStrings,
  type ConnectionTables,
  type EditorFacts,
  type EngineCatalog,
  type MigrationDdls,
  type QueryEditorFacts,
  type SqlGeneratorForms,
  type SqlTexts,
  type SqlWritings,
  projectCatalog,
  projectClaimRequests,
  projectConnectionForms,
  projectConnectionStrings,
  projectConnectionTables,
  projectEditorFacts,
  projectMigrationDdl,
  projectQueryEditorFacts,
  projectSqlGenerators,
  projectSqlText,
  projectSqlWriting,
} from "../src/lib/db/engine-catalog/projection";

/** The declarations' directory in the repository. */
export const ENGINE_DECLARATIONS_DIRECTORY = "src/lib/db/engine-declarations";

/** The generated catalog module in the repository. */
export const ENGINE_CATALOG_MODULE = "src/lib/db/engine-catalog/catalog.generated.ts";

/** The generated connection tables module in the repository. */
export const ENGINE_CONNECTION_MODULE = "src/lib/db/engine-catalog/connection.generated.ts";

/** The generated connection flags module in the repository: the connection tables src/lib/db/compatibility.ts reads. */
export const ENGINE_CONNECTION_FLAGS_MODULE = "src/lib/db/engine-catalog/connection-flags.generated.ts";

/** The generated connection form module in the repository: the connection forms src/lib/db/connection-form.ts reads. */
export const ENGINE_CONNECTION_FORM_MODULE = "src/lib/db/engine-catalog/connection-form.generated.ts";

/**
 * The generated connection string module in the repository: the connection strings
 * src/lib/db/connection-string/index.ts reads.
 */
export const ENGINE_CONNECTION_STRING_MODULE = "src/lib/db/engine-catalog/connection-string.generated.ts";

/**
 * The generated editor module in the repository: each engine's execution UI, which src/lib/db/execution-ui/index.ts
 * reads, and the fence aliases, which src/lib/sql/fence-tags.ts reads.
 */
export const ENGINE_EDITOR_MODULE = "src/lib/db/engine-catalog/editor.generated.ts";

/**
 * The generated query editor module in the repository: the query dialects, which src/lib/db/query-dialects.ts reads,
 * the tab type editors, which src/lib/editor/dialect-editors.ts reads, and the editor languages, which
 * src/lib/db/editor-language/index.ts reads.
 */
export const ENGINE_QUERY_EDITOR_MODULE = "src/lib/db/engine-catalog/query-editor.generated.ts";

/**
 * The generated SQL text module in the repository: each engine's SQL text, which src/lib/db/sql-grammar/index.ts reads.
 */
export const ENGINE_SQL_TEXT_MODULE = "src/lib/db/engine-catalog/sql-text.generated.ts";

/**
 * The generated SQL writing module in the repository: each engine's SQL writing, which src/lib/db/sql-writing/index.ts
 * reads.
 */
export const ENGINE_SQL_WRITING_MODULE = "src/lib/db/engine-catalog/sql-writing.generated.ts";

/**
 * The generated migration DDL module in the repository: each engine's migration DDL, which
 * src/lib/db/migration-ddl/index.ts reads.
 */
export const ENGINE_MIGRATION_DDL_MODULE = "src/lib/db/engine-catalog/migration-ddl.generated.ts";

/**
 * The generated SQL generator module in the repository: each SQL engine's generator forms, which
 * src/lib/db/query-generators/index.ts reads.
 */
export const ENGINE_SQL_GENERATORS_MODULE = "src/lib/db/engine-catalog/sql-generators.generated.ts";

/**
 * The generated claim requests module in the repository: each engine's policy, MCP, connection and agent mode claim
 * requests, which only src/lib/db/claim-grants.ts reads.
 */
export const ENGINE_CLAIMS_MODULE = "src/lib/db/engine-catalog/claims.generated.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCHEMA_FILE = path.join(REPO_ROOT, "packages/provider-sdk/src/manifest/manifest.schema.json");
const WRITE_COMMAND = "bun run engines:generate";
const USAGE = "Usage: bun scripts/generate-engine-catalog.ts --write | --check [--out <directory>]";
const HEADER = [
  `// Generated by scripts/generate-engine-catalog.ts from ${ENGINE_DECLARATIONS_DIRECTORY}; never edit it by hand.`,
  `// Change a declaration's authored member and run: ${WRITE_COMMAND}`,
];
/** The formatter's line width (biome.json), which the connection modules' layout keeps to. */
const LINE_WIDTH = 120;
/**
 * The width under which the formatter keeps a member's string on its key's line however long it is: its indent width,
 * 2, plus the 3 characters a break must save (`user:` keeps its sentence, `message:` breaks before it).
 */
const SHORT_KEY_WIDTH = 5;

/** The members a declaration authors, as dotted paths: read from its committed file, never built from a table. */
export const AUTHORED_MEMBERS = [
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
  "facets.monitoring",
  "facets.maintenance",
  "facets.maintenanceSpecs",
  "facets.agentReadings",
  "agent.statementLanguage",
  "editor.commitKeyword",
  "editor.consentDeadline",
  "editor.fenceAliases",
  "editor.dialect",
  "editor.language",
  "sqlText.readsSqlText",
  "sqlText.grammar",
  "sqlText.redaction",
  "sqlText.updateTarget",
  "sqlText.completion",
  "sqlWriting",
  "migrationDdl",
  "sqlGenerators",
  "policy",
  "mcp",
  "safeguards",
] as const;

type Connection = EngineDeclaration["connection"];
type ConnectionStringOffer = Connection["connectionString"];
type Editor = EngineDeclaration["editor"];
type SqlText = EngineDeclaration["sqlText"];

/**
 * One declaration's authored members, as `authoredMembersOf` reads them, nested as the declaration nests them: the
 * members the projections read, the whole `facets` segment, and the SQL text's `redaction`, a claim no projection
 * reads, both of which the declaration generator writes back as authored.
 */
export type AuthoredMembers = AuthoredDeclaration & {
  readonly facets: EngineDeclaration["facets"];
  readonly sqlText: AuthoredDeclaration["sqlText"] & { readonly redaction: SqlText["redaction"] };
};

/** Whether `value` is an object, not an array, holding `member` as an own property. */
function holds(value: unknown, member: string): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, member);
}

/**
 * The authored members of `value`, the parsed text of the declaration file `file`, each read at its dotted path and
 * given as the file states it; the SDK's validator, which admits the whole file once the declaration generator has
 * written it, holds each to its type.
 *
 * @throws {Error} Naming the file and the member, for a value that lacks an authored member, the first in
 * `AUTHORED_MEMBERS` order; naming the file and the id, for a value whose `id` is not the file's name.
 */
export function authoredMembersOf(value: unknown, file: string): AuthoredMembers {
  const read = (member: (typeof AUTHORED_MEMBERS)[number]): unknown => {
    let current: unknown = value;
    for (const step of member.split(".")) {
      if (!holds(current, step) || current[step] === undefined) {
        throw new Error(`${file} lacks its authored member ${member}`);
      }
      current = current[step];
    }
    return current;
  };
  const authored: AuthoredMembers = {
    id: read("id") as string,
    displayName: read("displayName") as string,
    location: read("location") as EngineDeclaration["location"],
    connection: {
      fields: read("connection.fields") as Connection["fields"],
      defaults: read("connection.defaults") as Connection["defaults"],
      seedOnly: read("connection.seedOnly") as Connection["seedOnly"],
      refused: read("connection.refused") as Connection["refused"],
      connectionString: {
        accepted: read("connection.connectionString.accepted") as boolean,
        dialogOffersUri: read("connection.connectionString.dialogOffersUri") as boolean,
        scheme: read("connection.connectionString.scheme") as ConnectionStringOffer["scheme"],
        urlTls: read("connection.connectionString.urlTls") as ConnectionStringOffer["urlTls"],
        paste: read("connection.connectionString.paste") as ConnectionStringOffer["paste"],
        seedCheck: read("connection.connectionString.seedCheck") as ConnectionStringOffer["seedCheck"],
      },
      tls: read("connection.tls") as Connection["tls"],
      readsTrustMaterial: read("connection.readsTrustMaterial") as boolean,
      sshTunnel: read("connection.sshTunnel") as Connection["sshTunnel"],
      hostPathFields: read("connection.hostPathFields") as Connection["hostPathFields"],
      opensLocalFile: read("connection.opensLocalFile") as boolean,
      serverLevelWithoutDatabase: read("connection.serverLevelWithoutDatabase") as boolean,
      agentCredential: read("connection.agentCredential") as Connection["agentCredential"],
      dialog: read("connection.dialog") as Connection["dialog"],
      hostUriSchemes: read("connection.hostUriSchemes") as Connection["hostUriSchemes"],
      credentialWarnings: read("connection.credentialWarnings") as Connection["credentialWarnings"],
      fieldRules: read("connection.fieldRules") as Connection["fieldRules"],
      hostHint: read("connection.hostHint") as Connection["hostHint"],
      hostIdentity: read("connection.hostIdentity") as Connection["hostIdentity"],
      import: read("connection.import") as Connection["import"],
      connectBudgetMs: read("connection.connectBudgetMs") as Connection["connectBudgetMs"],
    },
    facets: {
      monitoring: read("facets.monitoring") as EngineDeclaration["facets"]["monitoring"],
      maintenance: read("facets.maintenance") as EngineDeclaration["facets"]["maintenance"],
      maintenanceSpecs: read("facets.maintenanceSpecs") as EngineDeclaration["facets"]["maintenanceSpecs"],
      agentReadings: read("facets.agentReadings") as EngineDeclaration["facets"]["agentReadings"],
    },
    agent: {
      statementLanguage: read("agent.statementLanguage") as EngineDeclaration["agent"]["statementLanguage"],
    },
    editor: {
      commitKeyword: read("editor.commitKeyword") as Editor["commitKeyword"],
      consentDeadline: read("editor.consentDeadline") as Editor["consentDeadline"],
      fenceAliases: read("editor.fenceAliases") as Editor["fenceAliases"],
      dialect: read("editor.dialect") as Editor["dialect"],
      language: read("editor.language") as Editor["language"],
    },
    sqlText: {
      readsSqlText: read("sqlText.readsSqlText") as boolean,
      grammar: read("sqlText.grammar") as SqlText["grammar"],
      redaction: read("sqlText.redaction") as SqlText["redaction"],
      updateTarget: read("sqlText.updateTarget") as SqlText["updateTarget"],
      completion: read("sqlText.completion") as SqlText["completion"],
    },
    sqlWriting: read("sqlWriting") as EngineDeclaration["sqlWriting"],
    migrationDdl: read("migrationDdl") as EngineDeclaration["migrationDdl"],
    sqlGenerators: read("sqlGenerators") as EngineDeclaration["sqlGenerators"],
    policy: read("policy") as EngineDeclaration["policy"],
    mcp: read("mcp") as EngineDeclaration["mcp"],
    safeguards: read("safeguards") as EngineDeclaration["safeguards"],
  };
  if (`${authored.id}.json` !== file) {
    throw new Error(`${file} names the engine id ${JSON.stringify(authored.id)}, not its file name`);
  }
  return authored;
}

/**
 * The parsed text of every entry of `directory`, in file name order, with its file name.
 *
 * @throws {Error} Naming the entry, for an entry that is not a `.json` file and a file that is not JSON.
 */
function declarationFiles(directory: string): { readonly file: string; readonly value: unknown }[] {
  return readdirSync(directory)
    .sort()
    .map((file) => {
      if (!file.endsWith(".json")) throw new Error(`${file} is not a declaration`);
      const text = readFileSync(path.join(directory, file), "utf8");
      try {
        return { file, value: JSON.parse(text) as unknown };
      } catch (error) {
        throw new Error(`${file} is not JSON: ${(error as Error).message}`, { cause: error });
      }
    });
}

/**
 * The authored members of every declaration of `directory`, in file name order, read without admitting the file:
 * `--write` projects these, since a file whose authored members just changed still holds the generated members the
 * previous ones gave until the declaration generator rewrites them, and the validator refuses that mix. The whole set
 * is admitted afterwards, by `--check`, which `bun run engines:generate` runs last.
 *
 * @throws {Error} Naming the entry, for an entry that is not a `.json` file, a file that is not JSON, a file that lacks
 * an authored member and a file whose `id` is not its file name.
 */
export function authoredDeclarations(
  directory: string = path.join(REPO_ROOT, ENGINE_DECLARATIONS_DIRECTORY),
): AuthoredMembers[] {
  return declarationFiles(directory).map(({ file, value }) => authoredMembersOf(value, file));
}

/**
 * Every declaration of `directory`, admitted through the SDK's validator, in file name order.
 *
 * @throws {Error} Naming the entry, for an entry that is not a `.json` file, a file that is not JSON, a declaration
 * the schema refuses and a declaration whose `id` is not its file name.
 */
export function admittedDeclarations(
  directory: string = path.join(REPO_ROOT, ENGINE_DECLARATIONS_DIRECTORY),
): EngineDeclaration[] {
  const validator = compileManifestValidator(readFileSync(SCHEMA_FILE));
  return declarationFiles(directory).map(({ file, value }) => {
    const verdict = validator.validateEngine(value);
    if (!verdict.admitted) {
      throw new Error(
        `${file} is refused by the provider manifest schema: ${verdict.refusals.map(refusalSentence).join(" ")}`,
      );
    }
    if (`${verdict.engine.id}.json` !== file) {
      throw new Error(
        `${file} declares the engine id ${JSON.stringify(verdict.engine.id)}, which is not its file name`,
      );
    }
    return verdict.engine;
  });
}

/** The text of the generated module for `catalog`: a header, two type imports and one frozen record. */
export function renderCatalog(catalog: EngineCatalog): string {
  const entries = Object.entries(catalog).map(
    ([id, entry]) =>
      `  ${id}: Object.freeze({ location: ${JSON.stringify(entry.location)}, connectBudgetMs: ${JSON.stringify(entry.connectBudgetMs)} }),`,
  );
  return [
    ...HEADER,
    'import type { DatabaseType } from "@/lib/types";',
    'import type { CatalogEntry } from "./projection";',
    "",
    "/** Studio's engine catalog, projected from the admitted engine declarations (docs/providers/CONTRACT.md, M-70). */",
    "export const BUNDLED_CATALOG: Readonly<Record<DatabaseType, CatalogEntry>> = Object.freeze({",
    ...entries,
    "});",
    "",
  ].join("\n");
}

/** A record member or key the module writes bare, as every engine id and field name is. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * A character the module does not write: a control character other than the line feed, below U+0020 and U+007F
 * to U+009F; the line and paragraph separators U+2028 and U+2029; the soft hyphen U+00AD; a zero-width character,
 * U+200B to U+200D and U+FEFF; and a lone surrogate. Each is invisible or breaks a line where it is read, and the
 * formatter may spell its escape otherwise. The line feed, which ends each of the schema's comment lines, is written as
 * its escape.
 */
const UNQUOTED_CHARACTER = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u00ad\u200b-\u200d\u2028\u2029\ufeff]|\p{Cs}/u;

/**
 * `text` as a string literal in the formatter's quotes: double quotes, unless the text holds more double quotes than
 * single ones, as the one projection refusal that quotes `{id}` and `{type}` does. A backslash is written doubled, a
 * line feed as `\n` and the quote escaped, and a printable character outside ASCII, such as an ellipsis, is written as
 * itself: spellings the formatter leaves as they are.
 *
 * @throws {Error} For a text holding a character `UNQUOTED_CHARACTER` names, which no declaration's text holds.
 */
function quoted(text: string): string {
  if (UNQUOTED_CHARACTER.test(text)) {
    throw new Error(
      `The generated module cannot write ${JSON.stringify(text)}: it holds a character it does not quote`,
    );
  }
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
  const doubles = text.split('"').length - 1;
  const singles = text.split("'").length - 1;
  return doubles > singles ? `'${escaped.replaceAll("'", "\\'")}'` : `"${escaped.replaceAll('"', '\\"')}"`;
}

/**
 * `key` as a record member: bare where it is an identifier, as every engine id and field name is, and otherwise in the
 * formatter's quotes, as the Monaco language `graph-cypher` is.
 *
 * @throws {Error} For a key holding a character `UNQUOTED_CHARACTER` names, as `quoted` refuses it.
 */
function memberKey(key: string): string {
  return IDENTIFIER.test(key) ? key : quoted(key);
}

/** Whether `value` is a record the module writes: an object that is not a list, made by an object literal. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * `value` on one line of the generated module `module`: a list or a record frozen, a list `as const` so each element
 * keeps its literal type, and an integer as its decimal text.
 *
 * @throws {Error} Naming `module`, for a value that is not a string, an integer, a boolean, null, a list or a record of
 * them, which no member the generated modules read holds.
 */
function flat(module: string, value: unknown): string {
  if (typeof value === "string") return quoted(value);
  if (typeof value === "boolean" || value === null || Number.isSafeInteger(value)) return String(value);
  const write = (member: unknown) => flat(module, member);
  if (Array.isArray(value)) return `Object.freeze([${value.map(write).join(", ")}] as const)`;
  if (!isRecord(value)) throw new Error(`The generated module ${module} cannot write ${String(value)}`);
  const members = Object.entries(value).map(([key, member]) => `${memberKey(key)}: ${write(member)}`);
  return members.length === 0 ? "Object.freeze({})" : `Object.freeze({ ${members.join(", ")} })`;
}

/**
 * The lines of `value` written after `head` and before `tail` at `indent` spaces: one line where it fits within the
 * line width; otherwise a list or a record one element or member per line, two spaces further in, and a member's string
 * on the line after its key where the key is `SHORT_KEY_WIDTH` or wider. A string in a list, or after a shorter key,
 * stays on its line whatever its width, as the formatter leaves it.
 */
function laidOut(module: string, value: unknown, indent: number, head: string, tail: string, key?: string): string[] {
  const line = `${head}${flat(module, value)}${tail}`;
  if (line.length <= LINE_WIDTH || typeof value === "boolean" || typeof value === "number" || value === null) {
    return [line];
  }
  const inner = " ".repeat(indent + 2);
  if (typeof value === "string") {
    return key === undefined || key.length < SHORT_KEY_WIDTH
      ? [line]
      : [head.trimEnd(), `${inner}${quoted(value)}${tail}`];
  }
  const close = " ".repeat(indent);
  if (Array.isArray(value)) {
    return [
      `${head}Object.freeze([`,
      ...value.flatMap((element) => laidOut(module, element, indent + 2, inner, ",")),
      `${close}] as const)${tail}`,
    ];
  }
  return [
    `${head}Object.freeze({`,
    ...Object.entries(value as Readonly<Record<string, unknown>>).flatMap(([key, member]) =>
      laidOut(module, member, indent + 2, `${inner}${memberKey(key)}: `, ",", key),
    ),
    `${close}})${tail}`,
  ];
}

/**
 * One exported record of the generated module `module`: its docblock, its declaration up to the record, and what
 * follows it.
 *
 * @throws {Error} Naming `module`, when the docblock's or the declaration's line is wider than the line width, which
 * the formatter would break.
 */
function renderedRecord(
  module: string,
  doc: string,
  declaration: string,
  record: Readonly<Record<string, unknown>>,
  after = "",
): string[] {
  const lines = [`/** ${doc} */`, `${declaration} Object.freeze({`];
  const wide = lines.find((line) => line.length > LINE_WIDTH);
  if (wide !== undefined) throw new Error(`A line of the generated module ${module} is too wide: ${wide}`);
  return [
    ...lines,
    ...Object.entries(record).flatMap(([id, row]) => laidOut(module, row, 2, `  ${memberKey(id)}: `, ",", id)),
    `})${after};`,
  ];
}

/**
 * The text of the generated connection module for `tables`: a header, type imports only, and four frozen records, each
 * read by exactly one owner module.
 */
export function renderConnectionTables(tables: ConnectionTables): string {
  return [
    ...HEADER,
    'import type { CredentialWarning, FieldName } from "@libredb/provider-sdk/manifest";',
    'import type { RefusedFieldRow, SeedOnlyFields } from "@/lib/db/connection-fields";',
    'import type { DatabaseType } from "@/lib/types";',
    "",
    ...renderedRecord(
      ENGINE_CONNECTION_MODULE,
      "Each engine's connection fields, `connection.fields`, read by `CONNECTION_FIELDS` (CONTRACT.md, M-71).",
      "export const BUNDLED_CONNECTION_FIELDS =",
      tables.fields,
      " satisfies Readonly<Record<DatabaseType, readonly FieldName[]>>",
    ),
    "",
    ...renderedRecord(
      ENGINE_CONNECTION_MODULE,
      "Each engine's seed-only fields, `connection.seedOnly`, read by `SEED_ONLY_FIELDS` (CONTRACT.md, M-71).",
      "export const BUNDLED_SEED_ONLY: Readonly<Record<DatabaseType, SeedOnlyFields | null>> =",
      tables.seedOnly,
    ),
    "",
    ...renderedRecord(
      ENGINE_CONNECTION_MODULE,
      "Each engine's refused fields, `connection.refused`, read by `REFUSED_CONNECTION_FIELDS` (CONTRACT.md, M-71).",
      "export const BUNDLED_REFUSED_FIELDS: Readonly<Record<DatabaseType, RefusedFieldRow>> =",
      tables.refused,
    ),
    "",
    ...renderedRecord(
      ENGINE_CONNECTION_MODULE,
      "Each engine's credential warnings, `connection.credentialWarnings`, read by `CREDENTIAL_WARNINGS` (M-71).",
      "export const BUNDLED_CREDENTIAL_WARNINGS =",
      tables.credentialWarnings,
      " satisfies Readonly<Partial<Record<DatabaseType, readonly CredentialWarning[]>>>",
    ),
    "",
  ].join("\n");
}

/**
 * The text of the generated connection flags module for `tables`: a header, one type import, and the three frozen
 * records src/lib/db/compatibility.ts reads.
 */
export function renderConnectionFlags(tables: ConnectionTables): string {
  return [
    ...HEADER,
    'import type { DatabaseType } from "@/lib/types";',
    "",
    ...renderedRecord(
      ENGINE_CONNECTION_FLAGS_MODULE,
      "Whether each engine's provider is handed trust material, `connection.readsTrustMaterial` (M-71).",
      "export const BUNDLED_READS_TRUST_MATERIAL: Readonly<Record<DatabaseType, boolean>> =",
      tables.readsTrustMaterial,
    ),
    "",
    ...renderedRecord(
      ENGINE_CONNECTION_FLAGS_MODULE,
      "Whether each engine's provider opens a connection string, `connection.connectionString.accepted` (M-71).",
      "export const BUNDLED_CONNECTION_STRING_ACCEPTED: Readonly<Record<DatabaseType, boolean>> =",
      tables.connectionStringAccepted,
    ),
    "",
    ...renderedRecord(
      ENGINE_CONNECTION_FLAGS_MODULE,
      "Whether each engine's dialog offers a URI mode, `connection.connectionString.dialogOffersUri` (M-71).",
      "export const BUNDLED_DIALOG_OFFERS_URI: Readonly<Record<DatabaseType, boolean>> =",
      tables.dialogOffersUri,
    ),
    "",
  ].join("\n");
}

/**
 * The text of the generated module `module`, holding one frozen record of projected entries: a header, the type-id
 * union's and `entryType`'s type imports, and the record under `doc` and `declaration`, typed over the union. The record
 * is annotated with that type, or, where `typing` is `satisfies`, checked against it, so each entry keeps its literal
 * type.
 */
function renderedEntryModule(
  module: string,
  entryType: string,
  doc: string,
  declaration: string,
  record: Readonly<Record<string, unknown>>,
  typing: "annotation" | "satisfies" = "annotation",
): string {
  const type = `Readonly<Record<DatabaseType, ${entryType}>>`;
  return [
    ...HEADER,
    'import type { DatabaseType } from "@/lib/types";',
    `import type { ${entryType} } from "./projection";`,
    "",
    ...(typing === "annotation"
      ? renderedRecord(module, doc, `${declaration}: ${type} =`, record)
      : renderedRecord(module, doc, `${declaration} =`, record, ` satisfies ${type}`)),
    "",
  ].join("\n");
}

/**
 * The text of the generated connection form module for `forms`: a header, type imports only, and one frozen record,
 * read by src/lib/db/connection-form.ts.
 */
export function renderConnectionForms(forms: ConnectionForms): string {
  return renderedEntryModule(
    ENGINE_CONNECTION_FORM_MODULE,
    "ConnectionFormEntry",
    "Each engine's connection form, its display name and connection dialog members, read by `CONNECTION_FORM` (M-72).",
    "export const BUNDLED_CONNECTION_FORMS",
    forms,
  );
}

/**
 * The text of the generated connection string module for `strings`: a header, type imports only, and one frozen
 * record, read by src/lib/db/connection-string/index.ts.
 */
export function renderConnectionStrings(strings: ConnectionStrings): string {
  return renderedEntryModule(
    ENGINE_CONNECTION_STRING_MODULE,
    "ConnectionStringEntry",
    "Each engine's connection string, its scheme and the functions it names, read by `CONNECTION_STRING` (M-74).",
    "export const BUNDLED_CONNECTION_STRINGS",
    strings,
  );
}

/**
 * The text of the generated editor module for `facts`: a header, type imports only, and two frozen records, each
 * engine's execution UI, read by src/lib/db/execution-ui/index.ts, and the fence aliases, read by
 * src/lib/sql/fence-tags.ts.
 */
export function renderEditorFacts(facts: EditorFacts): string {
  return [
    ...HEADER,
    'import type { DatabaseType } from "@/lib/types";',
    'import type { ExecutionUiEntry } from "./projection";',
    "",
    ...renderedRecord(
      ENGINE_EDITOR_MODULE,
      "Each engine's execution UI, `editor.commitKeyword` and `editor.consentDeadline`, read by `EXECUTION_UI` (M-75).",
      "export const BUNDLED_EXECUTION_UI: Readonly<Record<DatabaseType, ExecutionUiEntry>> =",
      facts.executionUi,
    ),
    "",
    ...renderedRecord(
      ENGINE_EDITOR_MODULE,
      "Each fence alias, `editor.fenceAliases`, mapped to its engine, read by `ALIAS_ENGINES` (M-75).",
      "export const BUNDLED_FENCE_ALIASES: Readonly<Record<string, DatabaseType>> =",
      facts.fenceAliases,
    ),
    "",
  ].join("\n");
}

/**
 * The text of the generated query editor module for `facts`: a header, type imports only, and three frozen records, the
 * query dialects, read by src/lib/db/query-dialects.ts, the tab type editors, read by src/lib/editor/dialect-editors.ts,
 * and the editor languages, read by src/lib/db/editor-language/index.ts.
 */
export function renderQueryEditorFacts(facts: QueryEditorFacts): string {
  return [
    ...HEADER,
    'import type { MonacoLanguageId, QueryDialect } from "@libredb/provider-sdk/manifest";',
    'import type { QueryTab } from "@/lib/types";',
    'import type { DialectEditorEntry, EditorLanguageEntry, QueryDialectEntry } from "./projection";',
    "",
    ...renderedRecord(
      ENGINE_QUERY_EDITOR_MODULE,
      "Each query dialect's row, `editor.dialect`, read by `QUERY_DIALECTS` (CONTRACT.md, M-77).",
      "export const BUNDLED_QUERY_DIALECTS: Readonly<Record<QueryDialect, QueryDialectEntry>> =",
      facts.queryDialects,
    ),
    "",
    ...renderedRecord(
      ENGINE_QUERY_EDITOR_MODULE,
      "Each tab type's editor language, `editor.language.monacoId`, read by `DIALECT_EDITORS` (CONTRACT.md, M-77).",
      'export const BUNDLED_DIALECT_EDITORS: Readonly<Record<QueryTab["type"], DialectEditorEntry>> =',
      facts.dialectEditors,
    ),
    "",
    ...renderedRecord(
      ENGINE_QUERY_EDITOR_MODULE,
      "Each editor language's accent and console, `editor.language`, read by `EDITOR_LANGUAGES` (CONTRACT.md, M-77).",
      "export const BUNDLED_EDITOR_LANGUAGES: Readonly<Record<MonacoLanguageId, EditorLanguageEntry>> =",
      facts.editorLanguages,
    ),
    "",
  ].join("\n");
}

/**
 * The text of the generated SQL text module for `texts`: a header, type imports only, and one frozen record, read by
 * src/lib/db/sql-grammar/index.ts.
 */
export function renderSqlText(texts: SqlTexts): string {
  return renderedEntryModule(
    ENGINE_SQL_TEXT_MODULE,
    "SqlTextEntry",
    "Each engine's SQL text but its redaction, a claim, read by `SQL_GRAMMAR` (docs/providers/CONTRACT.md, M-78).",
    "export const BUNDLED_SQL_TEXT",
    texts,
  );
}

/**
 * The text of the generated SQL writing module for `writings`: a header, type imports only, and one frozen record, read
 * by src/lib/db/sql-writing/index.ts.
 */
export function renderSqlWriting(writings: SqlWritings): string {
  return renderedEntryModule(
    ENGINE_SQL_WRITING_MODULE,
    "SqlWritingEntry",
    "Each engine's SQL writing, its data and the names of its functions, read by `SQL_WRITING` (CONTRACT.md, M-79).",
    "export const BUNDLED_SQL_WRITING",
    writings,
  );
}

/**
 * The text of the generated migration DDL module for `ddls`: a header, type imports only, and one frozen record, read
 * by src/lib/db/migration-ddl/index.ts.
 */
export function renderMigrationDdl(ddls: MigrationDdls): string {
  return renderedEntryModule(
    ENGINE_MIGRATION_DDL_MODULE,
    "MigrationDdlEntry",
    "Each engine's migration DDL, its data and its function names, read by `MIGRATION_DDL` (CONTRACT.md, M-80).",
    "export const BUNDLED_MIGRATION_DDL",
    ddls,
  );
}

/**
 * The text of the generated SQL generator module for `forms`: a header, type imports only, and one frozen record, read
 * by src/lib/db/query-generators/index.ts.
 */
export function renderSqlGenerators(forms: SqlGeneratorForms): string {
  return renderedEntryModule(
    ENGINE_SQL_GENERATORS_MODULE,
    "SqlGeneratorsEntry",
    "Each engine's SQL generator forms, null where it writes the shared ones, read by `SQL_ENGINE_GENERATORS` (M-81).",
    "export const BUNDLED_SQL_GENERATORS",
    forms,
  );
}

/**
 * The text of the generated claim requests module for `requests`: a header, type imports only, and one frozen record,
 * read only by src/lib/db/claim-grants.ts, which grants each request against Studio's review of its claim for the
 * engine, which src/lib/db/claim-grants.ts states (clause M-54).
 * The record is checked against the entry type with `satisfies` rather than annotated with it, so each request keeps
 * its literal type, which the agent packs read through claim-grants.ts's `StatementLanguageRequest`.
 */
export function renderClaimRequests(requests: ClaimRequests): string {
  return renderedEntryModule(
    ENGINE_CLAIMS_MODULE,
    "ClaimRequestEntry",
    "Each engine's policy, MCP, connection and agent mode claim requests, read only by claim-grants.ts (M-83).",
    "export const BUNDLED_CLAIM_REQUESTS",
    requests,
    "satisfies",
  );
}

/** The current text of `file`, or null when it does not exist. */
function textOf(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The command line, exactly `--write` or `--check`, optionally followed by `--out <directory>`; null for anything
 * else, which the command refuses with its usage line, so a mistyped flag never rewrites a committed module.
 */
function parseArguments(argv: readonly string[]): { mode: "--write" | "--check"; out: string | undefined } | null {
  const [mode, flag, directory, ...rest] = argv;
  if (mode !== "--write" && mode !== "--check") return null;
  if (flag === undefined) return { mode, out: undefined };
  if (flag !== "--out" || directory === undefined || directory.startsWith("--") || rest.length > 0) return null;
  return { mode, out: directory };
}

function main(argv: readonly string[]): number {
  const parsed = parseArguments(argv);
  if (parsed === null) {
    console.error(USAGE);
    return 2;
  }
  const { mode, out } = parsed;
  const fileOf = (module: string) =>
    out === undefined ? path.join(REPO_ROOT, module) : path.join(path.resolve(out), path.basename(module));
  const declarations: readonly AuthoredDeclaration[] =
    mode === "--check" ? admittedDeclarations() : authoredDeclarations();
  const tables = projectConnectionTables(declarations);
  const modules = [
    { file: fileOf(ENGINE_CATALOG_MODULE), text: renderCatalog(projectCatalog(declarations)) },
    { file: fileOf(ENGINE_CONNECTION_MODULE), text: renderConnectionTables(tables) },
    { file: fileOf(ENGINE_CONNECTION_FLAGS_MODULE), text: renderConnectionFlags(tables) },
    { file: fileOf(ENGINE_CONNECTION_FORM_MODULE), text: renderConnectionForms(projectConnectionForms(declarations)) },
    {
      file: fileOf(ENGINE_CONNECTION_STRING_MODULE),
      text: renderConnectionStrings(projectConnectionStrings(declarations)),
    },
    { file: fileOf(ENGINE_EDITOR_MODULE), text: renderEditorFacts(projectEditorFacts(declarations)) },
    {
      file: fileOf(ENGINE_QUERY_EDITOR_MODULE),
      text: renderQueryEditorFacts(projectQueryEditorFacts(declarations)),
    },
    { file: fileOf(ENGINE_SQL_TEXT_MODULE), text: renderSqlText(projectSqlText(declarations)) },
    { file: fileOf(ENGINE_SQL_WRITING_MODULE), text: renderSqlWriting(projectSqlWriting(declarations)) },
    { file: fileOf(ENGINE_MIGRATION_DDL_MODULE), text: renderMigrationDdl(projectMigrationDdl(declarations)) },
    { file: fileOf(ENGINE_SQL_GENERATORS_MODULE), text: renderSqlGenerators(projectSqlGenerators(declarations)) },
    { file: fileOf(ENGINE_CLAIMS_MODULE), text: renderClaimRequests(projectClaimRequests(declarations)) },
  ];

  if (mode === "--check") {
    const stale = modules.filter(({ file, text }) => textOf(file) !== text);
    for (const { file } of stale) console.error(`${file} is not what the engine declarations project`);
    if (stale.length > 0) {
      console.error(`run: ${WRITE_COMMAND}`);
      return 1;
    }
    for (const { file } of modules) console.log(`${file} is up to date`);
    return 0;
  }

  for (const { file, text } of modules) {
    writeFileSync(file, text);
    console.log(`Wrote ${file}`);
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
