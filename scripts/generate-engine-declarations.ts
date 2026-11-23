#!/usr/bin/env bun
/**
 * Writes src/lib/db/engine-declarations/<type-id>.json, one engine declaration per shipped type-id, from today's
 * per-engine tables (docs/providers/CONTRACT.md, clause M-15).
 *
 * Each file is a `#/$defs/engineDeclaration` of the provider manifest schema
 * (packages/provider-sdk/src/manifest/manifest.schema.json): the engine's identity, its connection facts, its facets and
 * the statement language agent mode sends it. A full manifest also states the package's runtime and the products it
 * was measured against, facts no provider in `src/lib/db/providers/` has yet, so they are written when a provider moves
 * into a package of its own, from this declaration.
 *
 * The files are committed and never edited by hand, so a change to any table they come from lands with its declaration
 * diff. tests/unit/db/engine-declarations.test.ts rebuilds each in memory and fails on any byte of difference, holds
 * each to the schema, and reads each back to every table with read-back functions of its own.
 *
 * A refusal sentence the tables hold as a function becomes a template: the function is called with the placeholder
 * itself (`{field}`, or `{id}` and `{type}`), so the template is the sentence with each value's place marked, and the
 * census renders it back for every field.
 *
 * Run: bun scripts/generate-engine-declarations.ts --write | --check [--out <directory>]
 * --write writes every declaration and removes a `.json` file for an id no longer shipped, --check exits 1 naming each
 * declaration that differs, is missing or is not a shipped id, and --out names another directory for either, resolved
 * against the working directory. Both refuse, by name, an entry of the directory that is not a `.json` file.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  ConnectionDialog,
  CredentialWarning as ManifestCredentialWarning,
  EngineDeclaration,
  FieldName,
  PlaceableFieldName,
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
import { CREDENTIAL_WARNINGS } from "../src/lib/db/credential-warnings";
import { ENGINE_FACETS } from "../src/lib/db/engine-facets";
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

/**
 * How the dialog presents one engine's fields: each per-field record of its form as a list of entries naming their
 * field, in `fields` order, empty where the form declares none.
 */
function buildDialog(
  form: ConnectionFormSpec,
  fields: readonly ConnectionField[],
  type: DatabaseType,
): ConnectionDialog {
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

/** One engine's declaration, read from every table the contract states for it. */
export function buildEngineDeclaration(type: DatabaseType): EngineDeclaration {
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
      refused: Object.keys(REFUSED_CONNECTION_FIELDS[type]).map((field) => fieldName(field, type)),
      connectionString: { accepted: CONNECTION_STRING_ACCEPTED[type], dialogOffersUri: CONNECTION_FORM_URI_MODE[type] },
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

function main(argv: readonly string[]): number {
  const parsed = parseArguments(argv);
  if (parsed === null) {
    console.error(USAGE);
    return 2;
  }
  const { mode, out } = parsed;
  const directory = out === undefined ? path.join(REPO_ROOT, ENGINE_DECLARATIONS_DIRECTORY) : path.resolve(out);
  const entries = entriesOf(directory);
  const declarations = new Map(
    SHIPPED_DATABASE_TYPES.map((type) => [`${type}.json`, renderEngineDeclaration(buildEngineDeclaration(type))]),
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

  const foreign = entries.filter((entry) => !entry.endsWith(".json")).sort();
  if (foreign.length > 0) {
    console.error(
      `${directory} holds entries the generator does not own, so nothing was written:\n${foreign.map((entry) => `  ${entry} is not a declaration`).join("\n")}`,
    );
    return 1;
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
  process.exitCode = main(process.argv.slice(2));
}
