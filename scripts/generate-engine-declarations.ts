#!/usr/bin/env bun
/**
 * Writes src/lib/db/engine-declarations/<type-id>.json, one engine declaration per shipped type-id, from its authored
 * members, today's per-engine tables and what each engine's provider declares before it connects
 * (docs/providers/CONTRACT.md, clause M-15).
 *
 * A declaration's authored members, `AUTHORED_MEMBERS` (`id`, `displayName`, `location`, and of `connection` its
 * `fields`, `defaults`, `seedOnly`, `refused`, of its `connectionString` the `accepted`, `dialogOffersUri`, `scheme`,
 * `urlTls`, `paste` and `seedCheck`, and its `tls`, `readsTrustMaterial`, `dialog`, `hostUriSchemes`,
 * `credentialWarnings`, `fieldRules`, `hostHint`, `hostIdentity`, `import` and `connectBudgetMs`, of `editor` its
 * `commitKeyword`, `consentDeadline`, `fenceAliases`, `dialect` and `language`, of `sqlText` its `readsSqlText`,
 * `grammar`, `updateTarget` and `completion`, and the whole `sqlWriting` and `migrationDdl`), are written in the
 * declaration itself: this script reads them from the committed file of the engine in src/lib/db/engine-declarations,
 * whatever directory `--out` names, with `authoredMembersOf` (scripts/generate-engine-catalog.ts), which refuses by
 * name a file that lacks one or whose `id` is not its file name, and writes them back unchanged. Every other member is
 * built from the tables. The engine catalog, the connection tables, the connection forms, the connection strings, the
 * execution UI and fence aliases, the query dialects, tab type editors and editor languages, the SQL text, the SQL
 * writing and the migration DDL (scripts/generate-engine-catalog.ts, clauses M-70, M-71, M-72, M-74, M-75, M-77, M-78,
 * M-79 and M-80) project the authored members, and `bun run engines:generate` runs that command's `--write` first and
 * its `--check` last: this script builds every provider through the factory, which builds only an engine the catalog
 * holds, and `--check` admits every declaration this script wrote, with the SDK validator's rules, which refuse by
 * name, among others, a dialog entry or a field rule for a field the engine does not take and a placeable field with no
 * placement. A new engine's declaration therefore starts as a copy of another engine's file with its authored members
 * written for the new engine; the catalog generator projects it, this script writes every other member, and the catalog
 * generator then admits it.
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
 * The SQL text's `readsSqlText`, `grammar`, `updateTarget` and `completion` are authored, written back as the committed
 * file states them; the catalog generator projects them into src/lib/db/engine-catalog/sql-text.generated.ts, from
 * which Studio composes each engine's grammar row (clause M-78). A grammar fact the SDK's `SqlGrammar` type may leave
 * out is stated at the reading its readers give that absence (clause S-4), each trailing limit clause as its source and
 * flags, which the schema holds to i or iu and the validator to a pattern that compiles, and each completion reader
 * named by its slot, `formatSegment` and `readQuotedQualifier`. The redaction is a claim, written from Studio's record
 * of it, `SQL_TEXT_REDACTION` (src/lib/db/sql-grammar/redaction.ts), a command redaction's reader named
 * `redactionReader`.
 *
 * The SQL writing, `sqlWriting`, is authored as a whole and written back as the committed file states it; the catalog
 * generator projects it into src/lib/db/engine-catalog/sql-writing.generated.ts, from which Studio composes each
 * engine's SQL writing row (clause M-79). Each function is named by its slot: `escapeLiteral`, `unescapeLiteral`,
 * `quoteIdentifier`, `placeholder`, `temporalLiteral`, `insertDocuments`, `boundEdit`, `binaryLiteral`,
 * `rewriteDeclared`, `declareFromSample`, `typedLiteral`, `columnWriters` and `createTableKeyClause` for the create
 * table key's clause, each bound by Studio's SQL writing function table in src/lib/db/sql-writing/index.ts. Each type
 * pattern is its source and flags, which the schema holds to none, i, u or iu and the validator to a pattern that
 * compiles with one capturing group where it is a wrapper, and the bare type families are six lists keyed by kind.
 *
 * The migration DDL, `migrationDdl`, is authored as a whole and written back as the committed file states it; the
 * catalog generator projects it into src/lib/db/engine-catalog/migration-ddl.generated.ts, from which Studio composes
 * each engine's migration DDL row (clause M-80). A refused form is its refusal line, its null transaction wrapper and
 * its reasons; a written form is its transaction wrapper as `{ begin, commit }` or null, its CREATE TABLE by its kind,
 * each function named by its slot, `createTablePrimaryKey` and `createTableForeignKey` for a written CREATE TABLE's
 * key writers, `createTableRefusal` for a refused one's line, and `columnDef`, `createIndex`, `dropIndex`,
 * `addForeignKey`, `dropForeignKey`, `addColumn`, `dropColumn`, `modifyColumn` and `dropTable` for the statement
 * writers, each bound by Studio's migration DDL function table in src/lib/db/migration-ddl/index.ts, and its reasons.
 * `boundSegments` binds every name through that table before the declaration is written, so a name Studio holds no
 * function for stops this script by name.
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
 * The editor's commit keyword, consent deadline, fence aliases, dialect and language are authored, written back as the
 * committed file states them; the explain format comes from each engine's capabilities. The capabilities are read as
 * Studio reads a provider it never connects, `readProviderDeclarations` with the engine's census connection
 * (tests/helpers/census-connection.ts), so the declaration states the explain format the provider declares before it
 * connects, and the authored dialect and query language are held to the ones it declares. That read
 * builds every provider once, in a child process (scripts/read-engine-capabilities.ts) whose environment is
 * `CAPABILITY_READ_ENVIRONMENT`, empty, with no `.env` file loaded: a provider reads variables when it is built, and
 * one set where the generator runs, exported or in a `.env` file, never changes a declaration. The child loads each
 * provider module and logs one line per engine. The generator refuses by name, rather than write a declaration that
 * drops or misstates it: an explain format the provider's explain support contradicts, an authored dialect that is not
 * the query dialect the provider declares, and an authored query language that is not the one it declares.
 *
 * The dialect row and the editor language are projected from the declarations into Studio's query dialects, tab type
 * editors and editor languages (scripts/generate-engine-catalog.ts, clause M-77), which hold every declaration of one
 * dialect, tab type or language to one statement. A language's registration, completion source and formatter, and a
 * console's grammar and routes, stay browser code Studio's editor reads, composed with the accent and console the
 * declarations state (src/lib/db/editor-language/index.ts).
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
  Editor,
  EngineDeclaration,
  FieldName,
  MaintenanceSpec,
  PlanEstimate,
  ProfileComposition,
  ProfileTypePattern,
  Safeguards,
  SqlDialect,
  SqlGenerators,
  StatisticsReading,
  WritePathEvidence,
} from "@libredb/provider-sdk/manifest";
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
import { ENGINE_FACETS } from "../src/lib/db/engine-facets";
import { composeMigrationDdl, MIGRATION_DDL_FUNCTIONS } from "../src/lib/db/migration-ddl";
import { SQL_ENGINE_GENERATORS } from "../src/lib/db/query-generators";
import type { SqlEngineGenerators } from "../src/lib/db/query-generators/types";
import { SQL_TEXT_REDACTION } from "../src/lib/db/sql-grammar/redaction";
import type { MaintenanceOperation, ProviderCapabilities, WritePath, WritePathReach } from "../src/lib/db/types";
import type { DatabaseType } from "../src/lib/types";
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
 * One engine's editor facts: its `authored` commit keyword, consent deadline, fence aliases, dialect and language as
 * given, and the explain format its provider declares before it connects. An explain format the provider's explain
 * support contradicts, an authored dialect that is not the query dialect the provider declares, and an authored query
 * language that is not the one it declares, are thrown errors naming the engine.
 */
export function buildEditor(
  type: DatabaseType,
  capabilities: ProviderCapabilities,
  authored: AuthoredMembers["editor"],
): Editor {
  const { supportsExplain, explainFormat } = capabilities;
  if (supportsExplain && explainFormat === undefined) {
    throw new Error(`${type}: the provider supports explain but declares no explain format`);
  }
  if (!supportsExplain && explainFormat !== undefined) {
    throw new Error(`${type}: the provider declares an explain format but supports no explain`);
  }
  const stated = authored.dialect?.name;
  if (stated !== capabilities.queryDialect) {
    throw new Error(
      `${type}: the declaration states the query dialect ${stated ?? "none"}, and its provider declares ${capabilities.queryDialect ?? "none"}`,
    );
  }
  if (authored.language.queryLanguage !== capabilities.queryLanguage) {
    throw new Error(
      `${type}: the declaration states the query language ${authored.language.queryLanguage}, and its provider declares ${capabilities.queryLanguage}`,
    );
  }
  return {
    commitKeyword: authored.commitKeyword,
    consentDeadline: authored.consentDeadline,
    fenceAliases: authored.fenceAliases,
    explainFormat: explainFormat ?? null,
    dialect: authored.dialect,
    language: authored.language,
  };
}

/** The flags a profile type pattern may carry. */
const TYPE_PATTERN_FLAGS: readonly string[] = ["", "i", "u", "iu"];

/**
 * The engine's authored segments a Studio function table binds, `migrationDdl`, answered unchanged once every function
 * name it gives is bound through Studio's migration DDL function table, so a name Studio holds no function for stops
 * this script by name rather than reaching a committed declaration (docs/providers/CONTRACT.md, clauses M-15 and M-80).
 * The module that holds the table also composes every engine when it loads, from the generated module `--write` has
 * just written, which refuses the same name first; this call states the dependency rather than keeping an import for
 * its side effect.
 *
 * @throws {Error} Naming the engine and the name, for a function name Studio's table holds none for at its slot.
 */
export function boundSegments(type: DatabaseType, authored: AuthoredMembers): Pick<AuthoredMembers, "migrationDdl"> {
  composeMigrationDdl(type, authored.migrationDdl, MIGRATION_DDL_FUNCTIONS);
  return { migrationDdl: authored.migrationDdl };
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
  const bound = boundSegments(type, authored);
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
    sqlText: {
      readsSqlText: authored.sqlText.readsSqlText,
      grammar: authored.sqlText.grammar,
      redaction: SQL_TEXT_REDACTION[type],
      updateTarget: authored.sqlText.updateTarget,
      completion: authored.sqlText.completion,
    },
    sqlWriting: authored.sqlWriting,
    migrationDdl: bound.migrationDdl,
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
