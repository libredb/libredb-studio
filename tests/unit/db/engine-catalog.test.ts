/**
 * Studio's engine catalog, which engines it ships, where each lives and how long its open may take, its data-only
 * connection tables, its connection forms, its connection strings, each engine's execution UI and fence aliases, its
 * query dialects, tab type editors and editor languages, and each engine's SQL text, projected from the engine
 * declarations the catalog generator admits (docs/providers/CONTRACT.md, clauses M-70, M-71, M-72, M-74, M-75, M-77
 * and M-78).
 *
 * `scripts/generate-engine-catalog.ts` projects the committed declarations' authored members with `projectCatalog`,
 * `projectConnectionTables`, `projectConnectionForms`, `projectConnectionStrings`, `projectEditorFacts`,
 * `projectQueryEditorFacts` and `projectSqlText`, renders the projections into
 * `src/lib/db/engine-catalog/catalog.generated.ts`, `connection.generated.ts`, `connection-flags.generated.ts`,
 * `connection-form.generated.ts`, `connection-string.generated.ts`, `editor.generated.ts`, `query-editor.generated.ts`
 * and `sql-text.generated.ts`, the modules Studio's readers read, and holds each to the set it admits through the SDK's
 * digest-checked validator. This file holds the projections, the admission, the generated modules' bytes, the readers
 * that answer from them, and `bun run engines:generate` end to end on a scratch copy of the sources it reads.
 */
import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EngineDeclaration, FieldName } from "@libredb/provider-sdk/manifest";
import {
  admittedDeclarations,
  authoredDeclarations,
  ENGINE_CATALOG_MODULE,
  ENGINE_CONNECTION_FLAGS_MODULE,
  ENGINE_CONNECTION_FORM_MODULE,
  ENGINE_CONNECTION_MODULE,
  ENGINE_CONNECTION_STRING_MODULE,
  ENGINE_DECLARATIONS_DIRECTORY,
  ENGINE_EDITOR_MODULE,
  ENGINE_QUERY_EDITOR_MODULE,
  ENGINE_SQL_TEXT_MODULE,
  renderCatalog,
  renderConnectionFlags,
  renderConnectionForms,
  renderConnectionStrings,
  renderConnectionTables,
  renderEditorFacts,
  renderQueryEditorFacts,
  renderSqlText,
} from "../../../scripts/generate-engine-catalog";
import { EXTERNAL_DATABASE_TYPES, isExternalDatabaseType, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { BUNDLED_CATALOG } from "@/lib/db/engine-catalog/catalog.generated";
import {
  BUNDLED_CONNECTION_FIELDS,
  BUNDLED_CREDENTIAL_WARNINGS,
  BUNDLED_REFUSED_FIELDS,
  BUNDLED_SEED_ONLY,
} from "@/lib/db/engine-catalog/connection.generated";
import {
  BUNDLED_CONNECTION_STRING_ACCEPTED,
  BUNDLED_DIALOG_OFFERS_URI,
  BUNDLED_READS_TRUST_MATERIAL,
} from "@/lib/db/engine-catalog/connection-flags.generated";
import { BUNDLED_CONNECTION_FORMS } from "@/lib/db/engine-catalog/connection-form.generated";
import { BUNDLED_CONNECTION_STRINGS } from "@/lib/db/engine-catalog/connection-string.generated";
import { BUNDLED_EXECUTION_UI, BUNDLED_FENCE_ALIASES } from "@/lib/db/engine-catalog/editor.generated";
import {
  BUNDLED_DIALECT_EDITORS,
  BUNDLED_EDITOR_LANGUAGES,
  BUNDLED_QUERY_DIALECTS,
} from "@/lib/db/engine-catalog/query-editor.generated";
import { BUNDLED_SQL_TEXT } from "@/lib/db/engine-catalog/sql-text.generated";
import {
  type ConnectionFormEntry,
  type ConnectionForms,
  type ConnectionStringEntry,
  type ConnectionTables,
  projectCatalog,
  projectConnectionForms,
  projectConnectionStrings,
  projectConnectionTables,
  projectEditorFacts,
  projectQueryEditorFacts,
  projectSqlText,
} from "@/lib/db/engine-catalog/projection";
import type { DatabaseType } from "@/lib/types";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SCRIPT = path.join(ROOT, "scripts/generate-engine-catalog.ts");
const USAGE = "Usage: bun scripts/generate-engine-catalog.ts --write | --check [--out <directory>]";
const DIRECTORY = path.join(ROOT, ENGINE_DECLARATIONS_DIRECTORY);

/** The admitted set, read once: admission compiles the schema and validates every declaration. */
const ADMITTED: readonly EngineDeclaration[] = admittedDeclarations();

/** The admitted declaration of `id`. */
function admitted(id: string): EngineDeclaration {
  const declaration = ADMITTED.find((d) => d.id === id);
  if (declaration === undefined) throw new Error(`no admitted declaration of ${id}`);
  return declaration;
}

/** A scratch copy of the committed declarations directory, removed by the returned function. */
function scratchDirectory(): { readonly directory: string; readonly remove: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "engine-catalog-"));
  const directory = path.join(root, "declarations");
  mkdirSync(directory);
  for (const declaration of ADMITTED) {
    copyFileSync(path.join(DIRECTORY, `${declaration.id}.json`), path.join(directory, `${declaration.id}.json`));
  }
  return { directory, remove: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * A scratch copy of the sources the generators read, its node_modules linked to the repository's, so
 * `bun run engines:generate` runs with the copy as its repository root and never writes the committed tree.
 */
function generatingCopy(): {
  readonly root: string;
  readonly generate: () => { readonly exitCode: number; readonly stderr: string };
  readonly remove: () => void;
} {
  const root = mkdtempSync(path.join(tmpdir(), "engines-generate-"));
  for (const entry of ["package.json", "tsconfig.json", "scripts", "src", "packages", "tests/helpers"]) {
    cpSync(path.join(ROOT, entry), path.join(root, entry), {
      recursive: true,
      filter: (source) => path.basename(source) !== "node_modules",
    });
  }
  symlinkSync(path.join(ROOT, "node_modules"), path.join(root, "node_modules"), "junction");
  return {
    root,
    generate: () => {
      const run = Bun.spawnSync([process.execPath, "run", "engines:generate"], {
        cwd: root,
        env: { ...process.env, SEED_CONFIG_PATH: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { exitCode: run.exitCode, stderr: run.stderr.toString() };
    },
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Writes the copy's mongodb declaration with authSource dropped from its connection fields and localDataCenter added,
 * and its connection dialog as `dialog` answers from the committed one; answers the fields written.
 */
function editMongodbDeclaration(
  root: string,
  dialog: (committed: EngineDeclaration["connection"]["dialog"]) => unknown,
): FieldName[] {
  const file = path.join(root, ENGINE_DECLARATIONS_DIRECTORY, "mongodb.json");
  const committed = JSON.parse(readFileSync(file, "utf8"));
  const fields: FieldName[] = [
    ...committed.connection.fields.filter((field: FieldName) => field !== "authSource"),
    "localDataCenter",
  ];
  const connection = { ...committed.connection, fields, dialog: dialog(committed.connection.dialog) };
  writeFileSync(file, `${JSON.stringify({ ...committed, connection }, null, 2)}\n`);
  return fields;
}

describe("the engine catalog, projected from the admitted declarations", () => {
  test("the catalog holds one entry per declaration, keyed in ascending id order whatever order they come in", () => {
    const catalog = projectCatalog([admitted("snowflake"), admitted("libredb"), admitted("bigquery")]);

    expect(Object.keys(catalog)).toEqual(["bigquery", "libredb", "snowflake"]);
    expect(catalog).toEqual({
      bigquery: { location: "external", connectBudgetMs: 140_000 },
      libredb: { location: "embedded", connectBudgetMs: null },
      snowflake: { location: "external", connectBudgetMs: 80_000 },
    });
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.values(catalog).every((entry) => Object.isFrozen(entry))).toBe(true);
    // An id sorts after the id it begins with, given in either order.
    expect(Object.keys(projectCatalog([admitted("influxdb3"), admitted("influxdb")]))).toEqual([
      "influxdb",
      "influxdb3",
    ]);
  });

  test("two declarations of one engine id are refused by name", () => {
    const twice = [admitted("postgres"), admitted("mysql"), admitted("postgres")];

    expect(() => projectCatalog(twice)).toThrow('The engine id "postgres" is declared twice.');
    expect(() => projectConnectionTables(twice)).toThrow('The engine id "postgres" is declared twice.');
    expect(() => projectConnectionForms(twice)).toThrow('The engine id "postgres" is declared twice.');
    expect(() => projectConnectionStrings(twice)).toThrow('The engine id "postgres" is declared twice.');
    expect(() => projectEditorFacts(twice)).toThrow('The engine id "postgres" is declared twice.');
    expect(() => projectQueryEditorFacts(twice)).toThrow('The engine id "postgres" is declared twice.');
  });

  test("the catalog reads only the members a declaration authors", () => {
    // Every member but the authored ones replaced with postgres's: the catalog the generator writes first, before the
    // declaration generator rewrites those members, is therefore already the final one (D-2's premise).
    const postgres = admitted("postgres");
    const replaced = ADMITTED.map(
      (d): EngineDeclaration => ({
        ...postgres,
        id: d.id,
        location: d.location,
        connection: { ...postgres.connection, connectBudgetMs: d.connection.connectBudgetMs },
      }),
    );

    expect(projectCatalog(replaced)).toEqual(projectCatalog(ADMITTED));
    // Vacuity: the replacement changed members the catalog would read if it read them.
    expect(replaced.filter((d, index) => d.displayName !== ADMITTED[index].displayName).length).toBeGreaterThan(0);
  });

  test("the connection tables hold one row per declaration, keyed in ascending id order whatever order they come in", () => {
    const tables = projectConnectionTables([admitted("snowflake"), admitted("libredb"), admitted("bigquery")]);
    const ids = ["bigquery", "libredb", "snowflake"];

    for (const table of Object.values(tables)) {
      expect(Object.keys(table)).toEqual(table === tables.credentialWarnings ? [] : ids);
    }
    expect(tables.fields).toEqual({
      bigquery: admitted("bigquery").connection.fields,
      libredb: ["database"],
      snowflake: admitted("snowflake").connection.fields,
    });
    expect(tables.seedOnly).toEqual({ bigquery: null, libredb: null, snowflake: null });
    expect(tables.refused).toEqual({ bigquery: {}, libredb: {}, snowflake: {} });
    expect(tables.readsTrustMaterial).toEqual({ bigquery: false, libredb: false, snowflake: false });
    expect(tables.connectionStringAccepted).toEqual({ bigquery: false, libredb: false, snowflake: false });
    expect(tables.dialogOffersUri).toEqual({ bigquery: false, libredb: false, snowflake: false });
    // An id sorts after the id it begins with, given in either order.
    const influx = projectConnectionTables([admitted("influxdb3"), admitted("influxdb")]);
    expect(Object.keys(influx.fields)).toEqual(["influxdb", "influxdb3"]);
    expect(Object.keys(influx.credentialWarnings)).toEqual(["influxdb", "influxdb3"]);

    // A refused list becomes a record in list order, a seed-only scope becomes kind with its templates kept, and an
    // engine with warnings holds them member by member.
    const rows = projectConnectionTables([admitted("rabbitmq"), admitted("elasticsearch"), admitted("qdrant")]);
    expect(Object.entries(rows.refused.rabbitmq)).toEqual(
      admitted("rabbitmq").connection.refused.map(({ field, refusal }) => [field, refusal]),
    );
    expect(Object.keys(rows.refused.rabbitmq)).toEqual(["database", "namespaces", "tlsServerName"]);
    const seedOnly = admitted("elasticsearch").connection.seedOnly;
    if (seedOnly === null) throw new Error("elasticsearch declares no seed-only fields");
    expect(rows.seedOnly.elasticsearch).toEqual({
      fields: ["apiKeyId", "apiKeySecret"],
      kind: "set",
      refusal: seedOnly.refusal,
      projectionRefusal: seedOnly.projectionRefusal,
    });
    expect(rows.seedOnly.elasticsearch?.projectionRefusal).toContain('"{id}" of type "{type}"');
    expect(rows.credentialWarnings).toEqual({
      qdrant: admitted("qdrant").connection.credentialWarnings,
      rabbitmq: admitted("rabbitmq").connection.credentialWarnings,
    });
    expect(rows.credentialWarnings.qdrant?.map((warning) => Object.keys(warning))).toEqual([
      ["kind", "noExp", "access", "message"],
      ["kind", "message"],
    ]);
    expect(Object.keys(rows.credentialWarnings.rabbitmq?.[0] ?? {})).toEqual(["kind", "user", "password", "message"]);

    // Frozen at every level: each table, each row, each warning and its access list.
    const frozen = (value: unknown): boolean =>
      typeof value !== "object" || value === null || (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(rows)).toBe(true);
    expect(frozen(tables)).toBe(true);
  });

  test("the connection tables read only the members a declaration authors", () => {
    // Every member but the authored ones replaced with postgres's: the tables the generator writes first, before the
    // declaration generator rewrites those members, are therefore already the final ones.
    const postgres = admitted("postgres");
    const replaced = ADMITTED.map(
      (d): EngineDeclaration => ({
        ...postgres,
        id: d.id,
        location: d.location,
        connection: {
          ...postgres.connection,
          fields: d.connection.fields,
          seedOnly: d.connection.seedOnly,
          refused: d.connection.refused,
          connectionString: {
            ...postgres.connection.connectionString,
            accepted: d.connection.connectionString.accepted,
            dialogOffersUri: d.connection.connectionString.dialogOffersUri,
          },
          readsTrustMaterial: d.connection.readsTrustMaterial,
          credentialWarnings: d.connection.credentialWarnings,
          connectBudgetMs: d.connection.connectBudgetMs,
        },
      }),
    );

    expect(projectConnectionTables(replaced)).toEqual(projectConnectionTables(ADMITTED));
    // Vacuity: the replacement changed connection members the tables would read if they read them.
    const differs = (read: (d: EngineDeclaration) => unknown) =>
      replaced.filter((d, index) => JSON.stringify(read(d)) !== JSON.stringify(read(ADMITTED[index]))).length;
    expect(differs((d) => d.connection.tls)).toBeGreaterThan(0);
    expect(differs((d) => d.connection.agentCredential)).toBeGreaterThan(0);
    expect(differs((d) => d.connection.connectionString.scheme)).toBeGreaterThan(0);
  });

  test("the connection forms hold one entry per declaration, keyed in ascending id order whatever order they come in", () => {
    const forms = projectConnectionForms([admitted("snowflake"), admitted("libredb"), admitted("kubernetes")]);

    expect(Object.keys(forms)).toEqual(["kubernetes", "libredb", "snowflake"]);
    // Each entry holds the nine form members in one order, each as the declaration states it.
    const entryOf = ({ displayName, connection }: EngineDeclaration): ConnectionFormEntry => ({
      displayName,
      defaults: connection.defaults,
      tls: connection.tls,
      dialog: connection.dialog,
      hostUriSchemes: connection.hostUriSchemes,
      fieldRules: connection.fieldRules,
      hostHint: connection.hostHint,
      hostIdentity: connection.hostIdentity,
      import: connection.import,
    });
    for (const id of Object.keys(forms)) {
      expect(forms[id]).toEqual(entryOf(admitted(id)));
      expect(Object.keys(forms[id] ?? {})).toEqual([
        "displayName",
        "defaults",
        "tls",
        "dialog",
        "hostUriSchemes",
        "fieldRules",
        "hostHint",
        "hostIdentity",
        "import",
      ]);
    }
    // Functions stay names, and a pattern stays its source and flags.
    expect(forms.snowflake?.hostHint).toBe("hostHint");
    expect(forms.snowflake?.fieldRules.find((rule) => rule.field === "host")?.check).toBe("hostCheck");
    expect(forms.kubernetes?.import).toEqual({ label: "Import kubeconfig", importer: "importer" });
    expect(forms.kubernetes?.fieldRules[0]?.format?.pattern).toEqual({
      source: "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$",
      flags: "",
    });
    // An id sorts after the id it begins with, given in either order.
    expect(Object.keys(projectConnectionForms([admitted("influxdb3"), admitted("influxdb")]))).toEqual([
      "influxdb",
      "influxdb3",
    ]);

    // Frozen at every level, and a copy: no list or record of the declaration is handed out.
    const frozen = (value: unknown): boolean =>
      typeof value !== "object" || value === null || (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(forms)).toBe(true);
    expect(forms.snowflake?.dialog).not.toBe(admitted("snowflake").connection.dialog);
    expect(forms.snowflake?.dialog.labels).not.toBe(admitted("snowflake").connection.dialog.labels);
  });

  test("the connection forms read only the members a declaration authors", () => {
    // Every member but the authored ones replaced with postgres's: the forms the generator writes first, before the
    // declaration generator rewrites those members, are therefore already the final ones.
    const postgres = admitted("postgres");
    const replaced = ADMITTED.map(
      (d): EngineDeclaration => ({
        ...postgres,
        id: d.id,
        displayName: d.displayName,
        connection: {
          ...postgres.connection,
          defaults: d.connection.defaults,
          tls: d.connection.tls,
          dialog: d.connection.dialog,
          hostUriSchemes: d.connection.hostUriSchemes,
          fieldRules: d.connection.fieldRules,
          hostHint: d.connection.hostHint,
          hostIdentity: d.connection.hostIdentity,
          import: d.connection.import,
        },
      }),
    );

    expect(projectConnectionForms(replaced)).toEqual(projectConnectionForms(ADMITTED));
    // Vacuity: the replacement changed members the forms would read if they read them.
    const differs = (read: (d: EngineDeclaration) => unknown) =>
      replaced.filter((d, index) => JSON.stringify(read(d)) !== JSON.stringify(read(ADMITTED[index]))).length;
    expect(differs((d) => d.connection.fields)).toBeGreaterThan(0);
    expect(differs((d) => d.connection.sshTunnel)).toBeGreaterThan(0);
    expect(differs((d) => d.connection.connectionString.scheme)).toBeGreaterThan(0);
    expect(differs((d) => d.location)).toBeGreaterThan(0);
  });

  test("the connection strings hold one entry per declaration, keyed in ascending id order whatever order they come in", () => {
    const strings = projectConnectionStrings([admitted("snowflake"), admitted("mssql"), admitted("bigquery")]);

    expect(Object.keys(strings)).toEqual(["bigquery", "mssql", "snowflake"]);
    // Each entry holds the four connection string members a declaration authors, in one order, as it states them.
    const entryOf = ({ connection: { connectionString } }: EngineDeclaration): ConnectionStringEntry => ({
      scheme: connectionString.scheme,
      urlTls: connectionString.urlTls,
      paste: connectionString.paste,
      seedCheck: connectionString.seedCheck,
    });
    for (const id of Object.keys(strings)) {
      expect(strings[id]).toEqual(entryOf(admitted(id)));
      expect(Object.keys(strings[id] ?? {})).toEqual(["scheme", "urlTls", "paste", "seedCheck"]);
    }
    expect(strings.bigquery).toEqual({ scheme: null, urlTls: null, paste: null, seedCheck: null });
    // Functions stay names, and a paste keeps its reader's name, its catch-all flag and its formats in order.
    expect(strings.mssql).toEqual({
      scheme: "mssql",
      urlTls: "urlTls",
      paste: { reader: "pasteReader", catchAll: false, formats: ["mssql://", "Server=\u2026 (ADO.NET)"] },
      seedCheck: null,
    });
    expect(Object.keys(strings.mssql?.paste ?? {})).toEqual(["reader", "catchAll", "formats"]);
    expect(strings.snowflake?.seedCheck).toBe("seedCheck");
    // An id sorts after the id it begins with, given in either order.
    expect(Object.keys(projectConnectionStrings([admitted("influxdb3"), admitted("influxdb")]))).toEqual([
      "influxdb",
      "influxdb3",
    ]);

    // Frozen at every level, and a copy: no list or record of the declaration is handed out.
    const frozen = (value: unknown): boolean =>
      typeof value !== "object" || value === null || (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(strings)).toBe(true);
    expect(strings.mssql?.paste).not.toBe(admitted("mssql").connection.connectionString.paste);
    expect(strings.mssql?.paste?.formats).not.toBe(admitted("mssql").connection.connectionString.paste?.formats);
  });

  test("the connection strings read only the members a declaration authors", () => {
    // Every member but the authored ones replaced with postgres's: the connection strings the generator writes first,
    // before the declaration generator rewrites those members, are therefore already the final ones.
    const postgres = admitted("postgres");
    const replaced = ADMITTED.map(
      (d): EngineDeclaration => ({
        ...postgres,
        id: d.id,
        connection: {
          ...postgres.connection,
          connectionString: {
            ...postgres.connection.connectionString,
            scheme: d.connection.connectionString.scheme,
            urlTls: d.connection.connectionString.urlTls,
            paste: d.connection.connectionString.paste,
            seedCheck: d.connection.connectionString.seedCheck,
          },
        },
      }),
    );

    expect(projectConnectionStrings(replaced)).toEqual(projectConnectionStrings(ADMITTED));
    // Vacuity: the replacement changed members the connection strings would read if they read them.
    const differs = (read: (d: EngineDeclaration) => unknown) =>
      replaced.filter((d, index) => JSON.stringify(read(d)) !== JSON.stringify(read(ADMITTED[index]))).length;
    expect(differs((d) => d.connection.connectionString.accepted)).toBeGreaterThan(0);
    expect(differs((d) => d.connection.connectionString.dialogOffersUri)).toBeGreaterThan(0);
    expect(differs((d) => d.connection.sshTunnel)).toBeGreaterThan(0);
    expect(differs((d) => d.connection.dialog)).toBeGreaterThan(0);
    expect(differs((d) => d.location)).toBeGreaterThan(0);
  });

  test("the execution UI holds one entry per declaration and the fence aliases one per alias, keyed in ascending id order whatever order they come in", () => {
    const facts = projectEditorFacts([
      admitted("sqlite"),
      admitted("redis"),
      admitted("postgres"),
      admitted("bigquery"),
    ]);

    expect(Object.keys(facts)).toEqual(["executionUi", "fenceAliases"]);
    expect(Object.keys(facts.executionUi)).toEqual(["bigquery", "postgres", "redis", "sqlite"]);
    // Each entry holds the two execution UI members a declaration authors, in one order, as it states them.
    for (const id of Object.keys(facts.executionUi)) {
      const { editor } = admitted(id);
      expect(facts.executionUi[id]).toEqual({
        commitKeyword: editor.commitKeyword,
        consentDeadline: editor.consentDeadline,
      });
      expect(Object.keys(facts.executionUi[id] ?? {})).toEqual(["commitKeyword", "consentDeadline"]);
    }
    expect(facts.executionUi.bigquery).toEqual({ commitKeyword: "COMMIT", consentDeadline: null });
    expect(facts.executionUi.redis?.commitKeyword).toBe("EXEC");
    expect(facts.executionUi.sqlite?.consentDeadline).toEqual(admitted("sqlite").editor.consentDeadline);
    expect(Object.keys(facts.executionUi.sqlite?.consentDeadline ?? {})).toEqual(["chip", "sentence"]);
    // One alias entry per declared alias, mapped to its engine: in ascending id order, then each declaration's order.
    expect(facts.fenceAliases).toEqual({
      postgresql: "postgres",
      pgsql: "postgres",
      psql: "postgres",
      plpgsql: "postgres",
      rediscli: "redis",
      sqlite3: "sqlite",
    });
    expect(Object.keys(facts.fenceAliases)).toEqual([
      ...admitted("postgres").editor.fenceAliases,
      ...admitted("redis").editor.fenceAliases,
      ...admitted("sqlite").editor.fenceAliases,
    ]);
    // An id sorts after the id it begins with, given in either order.
    expect(Object.keys(projectEditorFacts([admitted("influxdb3"), admitted("influxdb")]).executionUi)).toEqual([
      "influxdb",
      "influxdb3",
    ]);

    // Frozen at every level, and a copy: no record of the declaration is handed out.
    const frozen = (value: unknown): boolean =>
      typeof value !== "object" || value === null || (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(facts)).toBe(true);
    expect(facts.executionUi.sqlite?.consentDeadline).not.toBe(admitted("sqlite").editor.consentDeadline);
  });

  test("the execution UI and the fence aliases read only the members a declaration authors", () => {
    // Every member but the authored ones replaced with postgres's: the editor facts the generator writes first, before
    // the declaration generator rewrites those members, are therefore already the final ones.
    const postgres = admitted("postgres");
    const replaced = ADMITTED.map(
      (d): EngineDeclaration => ({
        ...postgres,
        id: d.id,
        editor: {
          ...postgres.editor,
          commitKeyword: d.editor.commitKeyword,
          consentDeadline: d.editor.consentDeadline,
          fenceAliases: d.editor.fenceAliases,
        },
      }),
    );

    expect(projectEditorFacts(replaced)).toEqual(projectEditorFacts(ADMITTED));
    // Vacuity: the replacement changed members the editor facts would read if they read them.
    const differs = (read: (d: EngineDeclaration) => unknown) =>
      replaced.filter((d, index) => JSON.stringify(read(d)) !== JSON.stringify(read(ADMITTED[index]))).length;
    expect(differs((d) => d.editor.explainFormat)).toBeGreaterThan(0);
    expect(differs((d) => d.editor.dialect)).toBeGreaterThan(0);
    expect(differs((d) => d.editor.language)).toBeGreaterThan(0);
    expect(differs((d) => d.displayName)).toBeGreaterThan(0);
    expect(differs((d) => d.sqlText)).toBeGreaterThan(0);
  });

  test("an alias two declarations state, or one equal to another admitted engine id, is refused by name", () => {
    const withAliases = (id: string, fenceAliases: readonly string[]): EngineDeclaration => {
      const declaration = admitted(id);
      return { ...declaration, editor: { ...declaration.editor, fenceAliases } };
    };
    const mysql = admitted("mysql");

    // Two declarations state one alias: both engines are named, in id order, whatever order they come in.
    for (const set of [
      [mysql, withAliases("postgres", [...admitted("postgres").editor.fenceAliases, "mariadb"])],
      [withAliases("postgres", ["mariadb"]), mysql],
    ]) {
      expect(() => projectEditorFacts(set)).toThrow(
        'The fence alias "mariadb" is declared by both mysql and postgres.',
      );
    }
    // One declaration states one alias twice: the engine and the alias are named, and the repetition is said as such.
    expect(() => projectEditorFacts([mysql, withAliases("postgres", ["postgresql", "pgsql", "postgresql"])])).toThrow(
      'The fence alias "postgresql" of postgres is stated twice by its declaration.',
    );
    // An alias that is another admitted declaration's engine id.
    expect(() => projectEditorFacts([mysql, withAliases("postgres", ["mysql"])])).toThrow(
      'The fence alias "mysql" of postgres is the engine id of another admitted declaration.',
    );
    expect(() => projectEditorFacts([withAliases("mysql", ["postgres"]), admitted("postgres")])).toThrow(
      'The fence alias "postgres" of mysql is the engine id of another admitted declaration.',
    );
    // An alias equal to the declaration's own id, and a generic fence tag, are the validator's, per declaration.
    expect(() => projectEditorFacts([withAliases("postgres", ["postgres"])])).not.toThrow();
    expect(() => projectEditorFacts([withAliases("postgres", ["sql"])])).not.toThrow();
    // An alias of an id outside the set names no admitted engine, and none of the committed declarations is refused.
    expect(() => projectEditorFacts([withAliases("postgres", ["mysql"])])).not.toThrow();
    expect(() => projectEditorFacts(ADMITTED)).not.toThrow();
  });

  test("the query dialects, the tab type editors and the editor languages hold one entry per stated key, keyed in ascending order whatever order the declarations come in", () => {
    const set = ["postgres", "neo4j", "milvus", "mongodb", "kubernetes", "kafka", "mysql"].map(admitted);
    const facts = projectQueryEditorFacts(set);

    expect(Object.keys(facts)).toEqual(["queryDialects", "dialectEditors", "editorLanguages"]);
    // One dialect entry per stated dialect, its tab type the dialect's name and every member present, in one order.
    expect(facts.queryDialects).toEqual({
      kafka: {
        tabType: "kafka",
        offersColumnProfiling: false,
        offersCodeGeneration: false,
        offersCountQuery: false,
        offersSqlExport: true,
        historyMask: null,
      },
      kubectl: {
        tabType: "kubectl",
        offersColumnProfiling: false,
        offersCodeGeneration: false,
        offersCountQuery: false,
        offersSqlExport: false,
        historyMask: admitted("kubernetes").editor.dialect?.historyMask ?? null,
      },
      milvus: {
        tabType: "milvus",
        offersColumnProfiling: false,
        offersCodeGeneration: false,
        offersCountQuery: false,
        offersSqlExport: false,
        historyMask: null,
      },
    });
    expect(Object.keys(facts.queryDialects)).toEqual(["kafka", "kubectl", "milvus"]);
    for (const entry of Object.values(facts.queryDialects)) {
      expect(Object.keys(entry)).toEqual([
        "tabType",
        "offersColumnProfiling",
        "offersCodeGeneration",
        "offersCountQuery",
        "offersSqlExport",
        "historyMask",
      ]);
    }
    expect(facts.queryDialects.kubectl?.historyMask?.credentialFlags).toContain("--token");
    // One editor per tab type: a dialect engine's tabs open under the dialect's name, a dialect-less one's under its
    // query language's tab type, so MongoDB's JSON opens as mongodb and Neo4j's Cypher as cypher.
    expect(facts.dialectEditors).toEqual({
      cypher: { monacoId: "graph-cypher" },
      kafka: { monacoId: "json" },
      kubectl: { monacoId: "kubectl" },
      milvus: { monacoId: "milvus" },
      mongodb: { monacoId: "json" },
      sql: { monacoId: "sql" },
    });
    expect(Object.keys(facts.dialectEditors)).toEqual(["cypher", "kafka", "kubectl", "milvus", "mongodb", "sql"]);
    // One language entry per Monaco id, holding the accent and console the declarations state.
    expect(facts.editorLanguages).toEqual({
      "graph-cypher": { accent: "border-hue-purple/40", console: false },
      json: { accent: "border-hue-cyan/40", console: false },
      kubectl: { accent: "border-hue-teal-alt/40", console: false },
      milvus: { accent: "border-hue-teal/40", console: true },
      sql: { accent: "border-hue-blue/40", console: false },
    });
    expect(Object.keys(facts.editorLanguages)).toEqual(["graph-cypher", "json", "kubectl", "milvus", "sql"]);
    // The same answer for the set reversed and shuffled.
    expect(projectQueryEditorFacts([...set].reverse())).toEqual(facts);
    const shuffled = [set[3], set[0], set[6], set[1], set[5], set[2], set[4]];
    expect(JSON.stringify(projectQueryEditorFacts(shuffled))).toBe(JSON.stringify(facts));
    expect(JSON.stringify(projectQueryEditorFacts([...ADMITTED].reverse()))).toBe(
      JSON.stringify(projectQueryEditorFacts(ADMITTED)),
    );

    // Frozen at every level, and a copy: mutating the input after the call changes nothing.
    const frozen = (value: unknown): boolean =>
      typeof value !== "object" || value === null || (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(facts)).toBe(true);
    const kubernetes = structuredClone(admitted("kubernetes"));
    const copied = projectQueryEditorFacts([kubernetes]);
    const flags = kubernetes.editor.dialect?.historyMask?.credentialFlags as string[];
    flags.push("--edited");
    expect(copied.queryDialects.kubectl?.historyMask?.credentialFlags).not.toContain("--edited");
    expect(copied.queryDialects.kubectl?.historyMask?.credentialFlags).not.toBe(flags);
  });

  test("the query editor facts read only the members a declaration authors", () => {
    // Every member but the authored ones replaced with postgres's: the query editor facts the generator writes first,
    // before the declaration generator rewrites those members, are therefore already the final ones.
    const postgres = admitted("postgres");
    const replaced = ADMITTED.map(
      (d): EngineDeclaration => ({
        ...postgres,
        id: d.id,
        editor: { ...postgres.editor, dialect: d.editor.dialect, language: d.editor.language },
      }),
    );

    expect(projectQueryEditorFacts(replaced)).toEqual(projectQueryEditorFacts(ADMITTED));
    // Vacuity: the replacement changed members the query editor facts would read if they read them.
    const differs = (read: (d: EngineDeclaration) => unknown) =>
      replaced.filter((d, index) => JSON.stringify(read(d)) !== JSON.stringify(read(ADMITTED[index]))).length;
    expect(differs((d) => d.editor.explainFormat)).toBeGreaterThan(0);
    expect(differs((d) => d.editor.commitKeyword)).toBeGreaterThan(0);
    expect(differs((d) => d.editor.fenceAliases)).toBeGreaterThan(0);
    expect(differs((d) => d.displayName)).toBeGreaterThan(0);
    expect(differs((d) => d.sqlText)).toBeGreaterThan(0);
  });

  test("two declarations stating one dialect with different rows, one tab type in different editor languages, or one editor language with a different accent or console are refused by name", () => {
    const kafka = admitted("kafka");
    const bigquery = admitted("bigquery");
    const restated = (
      base: EngineDeclaration,
      editor: (committed: EngineDeclaration["editor"]) => Partial<EngineDeclaration["editor"]>,
    ): EngineDeclaration => ({ ...base, id: "acmefoo", editor: { ...base.editor, ...editor(base.editor) } });
    const dialect = kafka.editor.dialect as NonNullable<EngineDeclaration["editor"]["dialect"]>;
    const json = admitted("mongodb").editor.language;

    // One dialect stated with different rows: both engines named, in ascending id order, whatever order they come in.
    const counting = restated(kafka, () => ({ dialect: { ...dialect, offersCountQuery: true } }));
    for (const set of [
      [counting, kafka],
      [kafka, counting],
    ]) {
      expect(() => projectQueryEditorFacts(set)).toThrow(
        'The dialect "kafka" is stated with different rows by acmefoo and kafka.',
      );
    }
    // The flag list is compared in order.
    const kubernetes = admitted("kubernetes");
    const kubectl = kubernetes.editor.dialect as NonNullable<EngineDeclaration["editor"]["dialect"]>;
    const flags = kubectl.historyMask?.credentialFlags ?? [];
    const reordered = restated(kubernetes, () => ({
      dialect: { ...kubectl, historyMask: { credentialFlags: [...flags].reverse() } },
    }));
    expect(() => projectQueryEditorFacts([kubernetes, reordered])).toThrow(
      'The dialect "kubectl" is stated with different rows by acmefoo and kubernetes.',
    );
    // One tab type in different editor languages: a dialect-less SQL engine rendered in json, json's own facts kept.
    const inJson = restated(bigquery, (editor) => ({
      language: { ...json, queryLanguage: editor.language.queryLanguage },
    }));
    expect(() => projectQueryEditorFacts([bigquery, inJson])).toThrow(
      'The tab type "sql" is stated in different editor languages by acmefoo and bigquery.',
    );
    // One editor language with a different accent or console: a package restating Studio's sql or json is refused
    // while a Studio engine states it.
    const orange = restated(bigquery, (editor) => ({
      language: { ...editor.language, accent: "border-hue-orange/40" },
    }));
    expect(() => projectQueryEditorFacts([bigquery, orange])).toThrow(
      'The editor language "sql" is stated with a different accent or console by acmefoo and bigquery.',
    );
    const mongodb = admitted("mongodb");
    const jsonConsole = restated(mongodb, (editor) => ({ language: { ...editor.language, console: true } }));
    expect(() => projectQueryEditorFacts([mongodb, jsonConsole])).toThrow(
      'The editor language "json" is stated with a different accent or console by acmefoo and mongodb.',
    );
    // A second declaration stating kafka's exact row is admitted, with one entry.
    const same = restated(kafka, () => ({}));
    expect(Object.keys(projectQueryEditorFacts([kafka, same]).queryDialects)).toEqual(["kafka"]);
    // None of the committed declarations is refused.
    expect(() => projectQueryEditorFacts(ADMITTED)).not.toThrow();
  });

  test("projectSqlText answers each declaration's SQL text but its redaction, frozen, in ascending id order", () => {
    const set = ["postgres", "mongodb", "snowflake", "cassandra"].map(admitted);
    const texts = projectSqlText(set);

    expect(Object.keys(texts)).toEqual(["cassandra", "mongodb", "postgres", "snowflake"]);
    for (const declaration of set) {
      const { readsSqlText, grammar, updateTarget, completion } = declaration.sqlText;
      expect(texts[declaration.id]).toEqual({ readsSqlText, grammar, updateTarget, completion });
      // Each member in one order, the redaction never among them: it is a claim, kept in Studio's record.
      expect(Object.keys(texts[declaration.id] ?? {})).toEqual([
        "readsSqlText",
        "grammar",
        "updateTarget",
        "completion",
      ]);
      // The grammar in the declaration's member order.
      expect(Object.keys(texts[declaration.id]?.grammar ?? {})).toEqual(Object.keys(grammar));
    }
    // The same answer for the set reversed, and for every committed declaration in any order.
    expect(JSON.stringify(projectSqlText([...set].reverse()))).toBe(JSON.stringify(texts));
    expect(JSON.stringify(projectSqlText([...ADMITTED].reverse()))).toBe(JSON.stringify(projectSqlText(ADMITTED)));
    // Frozen at every level, and a copy: mutating the input after the call changes nothing.
    const frozen = (value: unknown): boolean =>
      typeof value !== "object" || value === null || (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(texts)).toBe(true);
    const postgres = structuredClone(admitted("postgres"));
    const copied = projectSqlText([postgres]);
    (postgres.sqlText.grammar.nonNumericRowBounds as string[]).push("NONE");
    expect(copied.postgres?.grammar.nonNumericRowBounds).toEqual(["ALL"]);
    // Two declarations of one id are refused by name.
    expect(() => projectSqlText([admitted("postgres"), admitted("postgres")])).toThrow(
      'The engine id "postgres" is declared twice.',
    );
  });

  test("the SQL text reads only the members a declaration authors", () => {
    // Every member but the authored ones replaced with postgres's, its redaction included: the SQL text the generator
    // writes first, before the declaration generator rewrites those members, is therefore already the final one.
    const postgres = admitted("postgres");
    const replaced = ADMITTED.map(
      (d): EngineDeclaration => ({
        ...postgres,
        id: d.id,
        sqlText: {
          readsSqlText: d.sqlText.readsSqlText,
          grammar: d.sqlText.grammar,
          redaction: postgres.sqlText.redaction,
          updateTarget: d.sqlText.updateTarget,
          completion: d.sqlText.completion,
        },
      }),
    );

    expect(projectSqlText(replaced)).toEqual(projectSqlText(ADMITTED));
    // Vacuity: the replacement changed members the SQL text would read if it read them.
    const differs = (read: (d: EngineDeclaration) => unknown) =>
      replaced.filter((d, index) => JSON.stringify(read(d)) !== JSON.stringify(read(ADMITTED[index]))).length;
    expect(differs((d) => d.sqlText.redaction)).toBeGreaterThan(0);
    expect(differs((d) => d.sqlWriting)).toBeGreaterThan(0);
    expect(differs((d) => d.editor)).toBeGreaterThan(0);
    expect(differs((d) => d.policy)).toBeGreaterThan(0);
  });

  test("every committed declaration is admitted through the SDK's digest-checked validator before it is projected", () => {
    expect(ADMITTED.map((d) => d.id)).toEqual([...SHIPPED_DATABASE_TYPES]);
    expect(ADMITTED.length).toBe(SHIPPED_DATABASE_TYPES.length);
  });

  test("a declaration the schema refuses, one whose id is not its file name, and a stray entry are each refused by name", () => {
    const scratch = scratchDirectory();
    try {
      const { directory } = scratch;
      const kafka = readFileSync(path.join(directory, "kafka.json"), "utf8");

      writeFileSync(path.join(directory, "kafka.json"), JSON.stringify({ ...JSON.parse(kafka), location: "nearby" }));
      expect(() => admittedDeclarations(directory)).toThrow(
        /^kafka\.json is refused by the provider manifest schema: /,
      );

      writeFileSync(path.join(directory, "kafka.json"), JSON.stringify({ ...JSON.parse(kafka), id: "mqtt" }));
      expect(() => admittedDeclarations(directory)).toThrow(
        'kafka.json declares the engine id "mqtt", which is not its file name',
      );
      expect(() => authoredDeclarations(directory)).toThrow('kafka.json names the engine id "mqtt", not its file name');

      const unlocated = JSON.parse(kafka);
      delete unlocated.location;
      writeFileSync(path.join(directory, "kafka.json"), JSON.stringify(unlocated));
      expect(() => authoredDeclarations(directory)).toThrow("kafka.json lacks its authored member location");

      writeFileSync(path.join(directory, "kafka.json"), kafka);
      writeFileSync(path.join(directory, "notes.txt"), "kept\n");
      expect(() => admittedDeclarations(directory)).toThrow("notes.txt is not a declaration");
      expect(() => authoredDeclarations(directory)).toThrow("notes.txt is not a declaration");

      rmSync(path.join(directory, "notes.txt"));
      writeFileSync(path.join(directory, "acmefoo.json"), "{");
      expect(() => admittedDeclarations(directory)).toThrow(/^acmefoo\.json is not JSON: /);
      expect(() => authoredDeclarations(directory)).toThrow(/^acmefoo\.json is not JSON: /);

      rmSync(path.join(directory, "acmefoo.json"));
      expect(admittedDeclarations(directory)).toEqual([...ADMITTED]);
    } finally {
      scratch.remove();
    }
  });

  test("--write's authored members of a declaration the validator refuses until its generated members are rewritten", () => {
    const scratch = scratchDirectory();
    try {
      const { directory } = scratch;
      const mongodb = admitted("mongodb");
      const fields: FieldName[] = [
        ...mongodb.connection.fields.filter((field) => field !== "authSource"),
        "localDataCenter",
      ];
      writeFileSync(
        path.join(directory, "mongodb.json"),
        JSON.stringify({ ...mongodb, connection: { ...mongodb.connection, fields } }),
      );

      // The declaration's dialog, authored for the previous fields, still places authSource and leaves localDataCenter
      // unplaced, so the validator refuses the file while --write still projects its authored members.
      expect(() => admittedDeclarations(directory)).toThrow(
        /^mongodb\.json is refused by the provider manifest schema: .*has no placement in the engine's connection dialog\.$/,
      );
      const authored = authoredDeclarations(directory);
      expect(authored.map((d) => d.id)).toEqual(ADMITTED.map((d) => d.id));
      expect(projectConnectionTables(authored).fields.mongodb).toEqual(fields);
      // The authored members of an unedited file are the admitted declaration's, so both modes project one set alike.
      writeFileSync(path.join(directory, "mongodb.json"), JSON.stringify(mongodb));
      expect(projectConnectionTables(authoredDeclarations(directory))).toEqual(projectConnectionTables(ADMITTED));
      expect(projectCatalog(authoredDeclarations(directory))).toEqual(projectCatalog(ADMITTED));
      expect(projectConnectionForms(authoredDeclarations(directory))).toEqual(projectConnectionForms(ADMITTED));
      expect(projectConnectionStrings(authoredDeclarations(directory))).toEqual(projectConnectionStrings(ADMITTED));
    } finally {
      scratch.remove();
    }
  });

  test("the committed catalog module is what the generator renders from the admitted declarations", () => {
    const committed = readFileSync(path.join(ROOT, ENGINE_CATALOG_MODULE), "utf8");

    expect(committed === renderCatalog(projectCatalog(ADMITTED))).toBe(true);
    expect(BUNDLED_CATALOG).toEqual(projectCatalog(ADMITTED));
    expect(committed).toContain("bun run engines:generate");
  });

  test("the committed connection modules are what the generator renders from the admitted declarations", () => {
    const committed = readFileSync(path.join(ROOT, ENGINE_CONNECTION_MODULE), "utf8");
    const flags = readFileSync(path.join(ROOT, ENGINE_CONNECTION_FLAGS_MODULE), "utf8");
    const tables = projectConnectionTables(ADMITTED);
    const bundled: ConnectionTables = {
      fields: BUNDLED_CONNECTION_FIELDS,
      seedOnly: BUNDLED_SEED_ONLY,
      refused: BUNDLED_REFUSED_FIELDS,
      credentialWarnings: BUNDLED_CREDENTIAL_WARNINGS as ConnectionTables["credentialWarnings"],
      readsTrustMaterial: BUNDLED_READS_TRUST_MATERIAL,
      connectionStringAccepted: BUNDLED_CONNECTION_STRING_ACCEPTED,
      dialogOffersUri: BUNDLED_DIALOG_OFFERS_URI,
    };

    expect(committed === renderConnectionTables(tables)).toBe(true);
    expect(flags === renderConnectionFlags(tables)).toBe(true);
    expect(bundled).toEqual(tables);
    // Each record keyed as the projection keys it, in ascending id order.
    for (const name of Object.keys(tables) as (keyof ConnectionTables)[]) {
      expect(Object.keys(bundled[name])).toEqual(Object.keys(tables[name]));
    }
    expect(committed).toContain("bun run engines:generate");
    expect(flags).toContain("bun run engines:generate");
    // Each record is written into exactly one of the two modules: the flags module holds the three compatibility.ts
    // reads, the connection module the other four.
    const exported = (text: string) => [...text.matchAll(/^export const (\w+)/gm)].map((match) => match[1]);
    expect(exported(committed)).toEqual([
      "BUNDLED_CONNECTION_FIELDS",
      "BUNDLED_SEED_ONLY",
      "BUNDLED_REFUSED_FIELDS",
      "BUNDLED_CREDENTIAL_WARNINGS",
    ]);
    expect(exported(flags)).toEqual([
      "BUNDLED_READS_TRUST_MATERIAL",
      "BUNDLED_CONNECTION_STRING_ACCEPTED",
      "BUNDLED_DIALOG_OFFERS_URI",
    ]);
  });

  test("the committed connection form module is what the generator renders from the admitted declarations", () => {
    const committed = readFileSync(path.join(ROOT, ENGINE_CONNECTION_FORM_MODULE), "utf8");
    const forms: ConnectionForms = projectConnectionForms(ADMITTED);

    expect(committed).toBe(renderConnectionForms(forms));
    expect(BUNDLED_CONNECTION_FORMS).toEqual(forms);
    expect(Object.keys(BUNDLED_CONNECTION_FORMS)).toEqual(Object.keys(forms));
    expect(committed).toContain("bun run engines:generate");
    expect([...committed.matchAll(/^export const (\w+)/gm)].map((match) => match[1])).toEqual([
      "BUNDLED_CONNECTION_FORMS",
    ]);
    // Frozen at every level, as the projection answers it.
    const frozen = (value: unknown): boolean =>
      typeof value !== "object" || value === null || (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(BUNDLED_CONNECTION_FORMS)).toBe(true);
  });

  test("the committed connection string module is what the generator renders from the admitted declarations", () => {
    const committed = readFileSync(path.join(ROOT, ENGINE_CONNECTION_STRING_MODULE), "utf8");
    const strings = projectConnectionStrings(ADMITTED);

    expect(committed).toBe(renderConnectionStrings(strings));
    expect(BUNDLED_CONNECTION_STRINGS).toEqual(strings);
    expect(Object.keys(BUNDLED_CONNECTION_STRINGS)).toEqual(Object.keys(strings));
    expect(committed).toContain("bun run engines:generate");
    expect([...committed.matchAll(/^export const (\w+)/gm)].map((match) => match[1])).toEqual([
      "BUNDLED_CONNECTION_STRINGS",
    ]);
    // Type imports only, so a reader of the module loads no other module through it.
    const imports = [...committed.matchAll(/^import .*$/gm)].map((match) => match[0]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((line) => line.startsWith("import type "))).toBe(true);
    // Frozen at every level, as the projection answers it.
    const frozen = (value: unknown): boolean =>
      typeof value !== "object" || value === null || (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(BUNDLED_CONNECTION_STRINGS)).toBe(true);
  });

  test("the committed editor module is what the generator renders from the admitted declarations", () => {
    const committed = readFileSync(path.join(ROOT, ENGINE_EDITOR_MODULE), "utf8");
    const facts = projectEditorFacts(ADMITTED);

    expect(committed).toBe(renderEditorFacts(facts));
    expect(BUNDLED_EXECUTION_UI).toEqual(facts.executionUi);
    expect(Object.keys(BUNDLED_EXECUTION_UI)).toEqual(Object.keys(facts.executionUi));
    expect(Object.keys(BUNDLED_EXECUTION_UI)).toEqual([...SHIPPED_DATABASE_TYPES]);
    expect<Readonly<Record<string, string>>>(BUNDLED_FENCE_ALIASES).toEqual(facts.fenceAliases);
    expect(Object.keys(BUNDLED_FENCE_ALIASES)).toEqual(Object.keys(facts.fenceAliases));
    expect(committed).toContain("bun run engines:generate");
    expect([...committed.matchAll(/^export const (\w+)/gm)].map((match) => match[1])).toEqual([
      "BUNDLED_EXECUTION_UI",
      "BUNDLED_FENCE_ALIASES",
    ]);
    // Type imports only, so a reader of the module loads no other module through it.
    const imports = [...committed.matchAll(/^import .*$/gm)].map((match) => match[0]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((line) => line.startsWith("import type "))).toBe(true);
    // Frozen at every level, as the projection answers it.
    const frozen = (value: unknown): boolean =>
      typeof value !== "object" || value === null || (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(BUNDLED_EXECUTION_UI)).toBe(true);
    expect(frozen(BUNDLED_FENCE_ALIASES)).toBe(true);
  });

  test("the committed query editor module is what the generator renders from the admitted declarations", () => {
    const committed = readFileSync(path.join(ROOT, ENGINE_QUERY_EDITOR_MODULE), "utf8");
    const facts = projectQueryEditorFacts(ADMITTED);

    expect(committed).toBe(renderQueryEditorFacts(facts));
    expect<unknown>(BUNDLED_QUERY_DIALECTS).toEqual(facts.queryDialects);
    expect(Object.keys(BUNDLED_QUERY_DIALECTS)).toEqual(Object.keys(facts.queryDialects));
    expect(Object.keys(BUNDLED_QUERY_DIALECTS)).toHaveLength(19);
    expect<unknown>(BUNDLED_DIALECT_EDITORS).toEqual(facts.dialectEditors);
    expect(Object.keys(BUNDLED_DIALECT_EDITORS)).toEqual(Object.keys(facts.dialectEditors));
    expect(Object.keys(BUNDLED_DIALECT_EDITORS)).toHaveLength(24);
    expect<unknown>(BUNDLED_EDITOR_LANGUAGES).toEqual(facts.editorLanguages);
    expect(Object.keys(BUNDLED_EDITOR_LANGUAGES)).toEqual(Object.keys(facts.editorLanguages));
    expect(Object.keys(BUNDLED_EDITOR_LANGUAGES)).toHaveLength(16);
    expect(committed).toContain("bun run engines:generate");
    expect([...committed.matchAll(/^export const (\w+)/gm)].map((match) => match[1])).toEqual([
      "BUNDLED_QUERY_DIALECTS",
      "BUNDLED_DIALECT_EDITORS",
      "BUNDLED_EDITOR_LANGUAGES",
    ]);
    // A key that is not an identifier is written in the formatter's quotes, as the formatter keeps it.
    expect(committed).toContain('  "graph-cypher": Object.freeze({ accent: "border-hue-purple/40", console: false }),');
    // Type imports only, so a reader of the module loads no other module through it.
    const imports = [...committed.matchAll(/^import .*$/gm)].map((match) => match[0]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((line) => line.startsWith("import type "))).toBe(true);
    // Frozen at every level, as the projection answers it.
    const frozen = (value: unknown): boolean =>
      typeof value !== "object" || value === null || (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(BUNDLED_QUERY_DIALECTS)).toBe(true);
    expect(frozen(BUNDLED_DIALECT_EDITORS)).toBe(true);
    expect(frozen(BUNDLED_EDITOR_LANGUAGES)).toBe(true);
  });

  test("the committed SQL text module is what the generator renders from the admitted declarations", () => {
    const committed = readFileSync(path.join(ROOT, ENGINE_SQL_TEXT_MODULE), "utf8");
    const texts = projectSqlText(ADMITTED);

    expect(committed).toBe(renderSqlText(texts));
    expect<unknown>(BUNDLED_SQL_TEXT).toEqual(texts);
    expect(Object.keys(BUNDLED_SQL_TEXT)).toEqual([...SHIPPED_DATABASE_TYPES]);
    expect(committed).toContain("bun run engines:generate");
    expect([...committed.matchAll(/^export const (\w+)/gm)].map((match) => match[1])).toEqual(["BUNDLED_SQL_TEXT"]);
    // A clause's source is written in the formatter's quotes, its backslashes doubled.
    expect(committed).toContain(String.raw`source: "\\s+ALLOW\\s+FILTERING\\s*$"`);
    // Type imports only, so a reader of the module loads no other module through it.
    const imports = [...committed.matchAll(/^import .*$/gm)].map((match) => match[0]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((line) => line.startsWith("import type "))).toBe(true);
    // Frozen at every level, as the projection answers it.
    const frozen = (value: unknown): boolean =>
      typeof value !== "object" || value === null || (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(BUNDLED_SQL_TEXT)).toBe(true);
  });

  test("the renderer writes a backslash, a character outside ASCII and a number as the formatter leaves them, and refuses a control character by name", () => {
    const tables = projectConnectionTables(ADMITTED);
    const refusal = (text: string) => ({ ...tables, refused: { ...tables.refused, qdrant: { user: text } } });
    const forms = projectConnectionForms(ADMITTED);
    const withPort = (port: number) => ({
      ...forms,
      qdrant: { ...(forms.qdrant as ConnectionFormEntry), defaults: { port } },
    });

    // A backslash is written doubled, so the module's string is the declaration's text.
    expect(renderConnectionTables(refusal("A back\\slash."))).toContain(
      'qdrant: Object.freeze({ user: "A back\\\\slash." }),',
    );
    // A printable character outside ASCII is written as itself.
    expect(renderConnectionTables(refusal("Caf\u00e9\u2026"))).toContain(
      'qdrant: Object.freeze({ user: "Caf\u00e9\u2026" }),',
    );
    // An integer is written as its decimal text.
    expect(renderConnectionForms(withPort(6334))).toContain("defaults: Object.freeze({ port: 6334 }),");
    // A control character, and a number that is not an integer, are refused by name.
    for (const text of ["A tab\there.", "A line\nbreak.", "A delete\u007f.", "A C1\u0085."]) {
      expect(() => renderConnectionTables(refusal(text))).toThrow(
        `The connection module cannot write ${JSON.stringify(text)}: it holds a character it does not quote`,
      );
    }
    expect(() => renderConnectionForms(withPort(6334.5))).toThrow("The connection module cannot write 6334.5");
    expect(() => renderConnectionForms(withPort(Number.NaN))).toThrow("The connection module cannot write NaN");
    // What the committed declarations hold: six patterns with a backslash, an ellipsis and every port.
    const rendered = renderConnectionForms(forms);
    expect(rendered).toContain('source: "^[A-Za-z0-9_-]{1,63}$"');
    expect(rendered).toContain(String.raw`source: "^[\\x21-\\x2b\\x2d\\x2e\\x30-\\x3c\\x3e-\\x7e]+$"`);
    expect(rendered).toContain("\u2026");
    expect(rendered).toContain("defaults: Object.freeze({ port: 5432 }),");
  });

  /** The renderer's refusal of `text` in a refused-field sentence, the one it gives a control character. */
  function expectUnquoted(text: string): void {
    const tables = projectConnectionTables(ADMITTED);
    const planted = { ...tables, refused: { ...tables.refused, qdrant: { user: text } } };
    expect(() => renderConnectionTables(planted)).toThrow(
      `The connection module cannot write ${JSON.stringify(text)}: it holds a character it does not quote`,
    );
  }

  test("the renderer refuses a line or paragraph separator by name, as it refuses a control character", () => {
    expectUnquoted("A line\u2028separator.");
    expectUnquoted("A paragraph\u2029separator.");
  });

  test("the renderer refuses a soft hyphen by name, as it refuses a control character", () => {
    expectUnquoted("A soft\u00adhyphen.");
  });

  test("the renderer refuses a zero-width character by name, as it refuses a control character", () => {
    expectUnquoted("A zero\u200bwidth space.");
    expectUnquoted("A zero\u200cwidth non-joiner.");
    expectUnquoted("A zero\u200dwidth joiner.");
    expectUnquoted("A byte\ufefforder mark.");
  });

  test("the renderer refuses a lone surrogate by name, and writes a surrogate pair as itself", () => {
    expectUnquoted("A lone high\ud83d.");
    expectUnquoted("A lone low\ude00.");
    const tables = projectConnectionTables(ADMITTED);
    const planted = { ...tables, refused: { ...tables.refused, qdrant: { user: "A pair\ud83d\ude00." } } };
    expect(renderConnectionTables(planted)).toContain('qdrant: Object.freeze({ user: "A pair\ud83d\ude00." }),');
  });

  test("the connection module refuses by name a value it cannot write as the formatter lays it out", () => {
    const tables = projectConnectionTables(ADMITTED);
    const refusal = (text: string) => ({ ...tables, refused: { ...tables.refused, qdrant: { user: text } } });
    const planted = (table: Partial<ConnectionTables>) => () => renderConnectionTables({ ...tables, ...table });
    const plantedFlag = (table: Partial<ConnectionTables>) => () => renderConnectionFlags({ ...tables, ...table });

    expect(planted(refusal("A tab\there."))).toThrow("it holds a character it does not quote");
    // A member that is not an identifier is written in the formatter's quotes, and one the quotes cannot hold refused.
    expect(renderConnectionFlags({ ...tables, readsTrustMaterial: { "acme-foo": true } })).toContain(
      '  "acme-foo": true,',
    );
    expect(plantedFlag({ readsTrustMaterial: { ...tables.readsTrustMaterial, "acme\tfoo": true } })).toThrow(
      "it holds a character it does not quote",
    );
    expect(plantedFlag({ dialogOffersUri: { ...tables.dialogOffersUri, qdrant: 1.5 as unknown as boolean } })).toThrow(
      "The connection module cannot write 1.5",
    );
    // A sentence holding more double quotes than single ones is written in single quotes, as the formatter writes it.
    expect(renderConnectionTables(refusal('Say "no" and "yes", it\'s fine.'))).toContain(
      `qdrant: Object.freeze({ user: 'Say "no" and "yes", it\\'s fine.' }),`,
    );
  });

  test("--check names a stale catalog module, --write writes it, and anything else is refused with the usage line", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "engine-catalog-module-"));
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    try {
      const committed = run("--check");
      expect(committed.stderr.toString()).toBe("");
      expect(committed.exitCode).toBe(0);

      expect(run("--write", "--out", dir).exitCode).toBe(0);
      const out = path.join(dir, "catalog.generated.ts");
      writeFileSync(out, readFileSync(path.join(ROOT, ENGINE_CATALOG_MODULE), "utf8").replace("140000", "150000"));
      const stale = run("--check", "--out", dir);
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr.toString()).toBe(
        `${out} is not what the engine declarations project\nrun: bun run engines:generate\n`,
      );

      rmSync(out);
      const missing = run("--check", "--out", dir);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr.toString()).toContain(`${out} is not what the engine declarations project`);

      expect(run("--write", "--out", dir).exitCode).toBe(0);
      expect(readFileSync(out, "utf8")).toBe(readFileSync(path.join(ROOT, ENGINE_CATALOG_MODULE), "utf8"));
      expect(run("--check", "--out", dir).exitCode).toBe(0);

      for (const args of [[], ["--check", "--write"], ["--write", "--out"], ["--check", "--verbose"]]) {
        const refused = run(...args);
        expect(refused.exitCode).toBe(2);
        expect(refused.stderr.toString()).toContain(USAGE);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Each run admits every declaration, a fraction of a second; well inside ten times that.
  }, 20000);

  test("--check names a stale connection module, and --write writes every projected module", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "engine-connection-module-"));
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    try {
      const written = run("--write", "--out", dir);
      expect(written.exitCode).toBe(0);
      const catalog = path.join(dir, "catalog.generated.ts");
      const connection = path.join(dir, "connection.generated.ts");
      const flags = path.join(dir, "connection-flags.generated.ts");
      const form = path.join(dir, "connection-form.generated.ts");
      const strings = path.join(dir, "connection-string.generated.ts");
      const editor = path.join(dir, "editor.generated.ts");
      const queryEditor = path.join(dir, "query-editor.generated.ts");
      const sqlText = path.join(dir, "sql-text.generated.ts");
      expect(written.stdout.toString()).toBe(
        `Wrote ${catalog}\nWrote ${connection}\nWrote ${flags}\nWrote ${form}\nWrote ${strings}\nWrote ${editor}\nWrote ${queryEditor}\nWrote ${sqlText}\n`,
      );
      expect(readFileSync(connection, "utf8")).toBe(readFileSync(path.join(ROOT, ENGINE_CONNECTION_MODULE), "utf8"));
      expect(readFileSync(flags, "utf8")).toBe(readFileSync(path.join(ROOT, ENGINE_CONNECTION_FLAGS_MODULE), "utf8"));
      expect(readFileSync(catalog, "utf8")).toBe(readFileSync(path.join(ROOT, ENGINE_CATALOG_MODULE), "utf8"));
      const current = run("--check", "--out", dir);
      expect(current.exitCode).toBe(0);
      expect(current.stdout.toString()).toBe(
        `${catalog} is up to date\n${connection} is up to date\n${flags} is up to date\n${form} is up to date\n${strings} is up to date\n${editor} is up to date\n${queryEditor} is up to date\n${sqlText} is up to date\n`,
      );

      const text = readFileSync(connection, "utf8");
      writeFileSync(connection, text.replace("Nothing was sent.", "Nothing at all was sent."));
      const stale = run("--check", "--out", dir);
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr.toString()).toBe(
        `${connection} is not what the engine declarations project\nrun: bun run engines:generate\n`,
      );

      writeFileSync(connection, text);
      writeFileSync(flags, readFileSync(flags, "utf8").replace("db2: true", "db2: false"));
      const staleFlags = run("--check", "--out", dir);
      expect(staleFlags.exitCode).toBe(1);
      expect(staleFlags.stderr.toString()).toBe(
        `${flags} is not what the engine declarations project\nrun: bun run engines:generate\n`,
      );

      rmSync(connection);
      rmSync(catalog);
      rmSync(flags);
      const missing = run("--check", "--out", dir);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr.toString()).toBe(
        `${catalog} is not what the engine declarations project\n${connection} is not what the engine declarations project\n${flags} is not what the engine declarations project\nrun: bun run engines:generate\n`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  test("--check names a stale connection form module, and --write writes every projected module", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "engine-connection-form-module-"));
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    try {
      expect(run("--write", "--out", dir).exitCode).toBe(0);
      const form = path.join(dir, "connection-form.generated.ts");
      const text = readFileSync(form, "utf8");
      expect(text).toBe(readFileSync(path.join(ROOT, ENGINE_CONNECTION_FORM_MODULE), "utf8"));

      // A hint edited by hand in the generated module is named, and only that module.
      writeFileSync(form, text.replace("Only for an encrypted key.", "Only for an encrypted private key."));
      const stale = run("--check", "--out", dir);
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr.toString()).toBe(
        `${form} is not what the engine declarations project\nrun: bun run engines:generate\n`,
      );

      rmSync(form);
      const missing = run("--check", "--out", dir);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr.toString()).toBe(
        `${form} is not what the engine declarations project\nrun: bun run engines:generate\n`,
      );

      expect(run("--write", "--out", dir).exitCode).toBe(0);
      expect(readFileSync(form, "utf8")).toBe(text);
      expect(run("--check", "--out", dir).exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Each run admits every declaration, a fraction of a second; well inside ten times that.
  }, 20000);

  test("--check names a stale connection string module, and --write writes every projected module", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "engine-connection-string-module-"));
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    try {
      expect(run("--write", "--out", dir).exitCode).toBe(0);
      const strings = path.join(dir, "connection-string.generated.ts");
      const text = readFileSync(strings, "utf8");
      expect(text).toBe(readFileSync(path.join(ROOT, ENGINE_CONNECTION_STRING_MODULE), "utf8"));

      // A format edited by hand in the generated module is named, and only that module.
      writeFileSync(strings, text.replace('"libsql://"', '"libsql://, https://"'));
      const stale = run("--check", "--out", dir);
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr.toString()).toBe(
        `${strings} is not what the engine declarations project\nrun: bun run engines:generate\n`,
      );

      rmSync(strings);
      const missing = run("--check", "--out", dir);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr.toString()).toBe(
        `${strings} is not what the engine declarations project\nrun: bun run engines:generate\n`,
      );

      expect(run("--write", "--out", dir).exitCode).toBe(0);
      expect(readFileSync(strings, "utf8")).toBe(text);
      expect(run("--check", "--out", dir).exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Each run admits every declaration, a fraction of a second; well inside ten times that.
  }, 20000);

  test("--check names a stale editor module, and --write writes every projected module", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "engine-editor-module-"));
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    try {
      expect(run("--write", "--out", dir).exitCode).toBe(0);
      const editor = path.join(dir, "editor.generated.ts");
      const text = readFileSync(editor, "utf8");
      expect(text).toBe(readFileSync(path.join(ROOT, ENGINE_EDITOR_MODULE), "utf8"));
      for (const generated of [
        ENGINE_CATALOG_MODULE,
        ENGINE_CONNECTION_MODULE,
        ENGINE_CONNECTION_FLAGS_MODULE,
        ENGINE_CONNECTION_FORM_MODULE,
        ENGINE_CONNECTION_STRING_MODULE,
        ENGINE_QUERY_EDITOR_MODULE,
        ENGINE_SQL_TEXT_MODULE,
      ]) {
        expect(readFileSync(path.join(dir, path.basename(generated)), "utf8")).toBe(
          readFileSync(path.join(ROOT, generated), "utf8"),
        );
      }

      // Redis's commit keyword edited by hand in the generated module is named, and only that module.
      writeFileSync(editor, text.replace('commitKeyword: "EXEC"', 'commitKeyword: "COMMIT"'));
      const stale = run("--check", "--out", dir);
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr.toString()).toBe(
        `${editor} is not what the engine declarations project\nrun: bun run engines:generate\n`,
      );

      rmSync(editor);
      const missing = run("--check", "--out", dir);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr.toString()).toBe(
        `${editor} is not what the engine declarations project\nrun: bun run engines:generate\n`,
      );

      expect(run("--write", "--out", dir).exitCode).toBe(0);
      expect(readFileSync(editor, "utf8")).toBe(text);
      expect(run("--check", "--out", dir).exitCode).toBe(0);

      // Kafka's count query offer edited by hand in the generated query editor module is named, and only that module.
      const queryEditor = path.join(dir, "query-editor.generated.ts");
      const queryEditorText = readFileSync(queryEditor, "utf8");
      const kafkaRow = /^ {2}kafka: Object\.freeze\(\{$[\s\S]*?^ {2}\}\),$/m.exec(queryEditorText)?.[0] ?? "";
      expect(kafkaRow).toContain("offersCountQuery: false,");
      writeFileSync(
        queryEditor,
        queryEditorText.replace(kafkaRow, kafkaRow.replace("offersCountQuery: false,", "offersCountQuery: true,")),
      );
      const staleQueryEditor = run("--check", "--out", dir);
      expect(staleQueryEditor.exitCode).toBe(1);
      expect(staleQueryEditor.stderr.toString()).toBe(
        `${queryEditor} is not what the engine declarations project\nrun: bun run engines:generate\n`,
      );
      expect(run("--write", "--out", dir).exitCode).toBe(0);
      expect(readFileSync(queryEditor, "utf8")).toBe(queryEditorText);
      expect(run("--check", "--out", dir).exitCode).toBe(0);

      // Trino's readsSqlText edited by hand in the generated SQL text module is named, and only that module.
      const sqlText = path.join(dir, "sql-text.generated.ts");
      const sqlTextText = readFileSync(sqlText, "utf8");
      const trinoEntry = /^ {2}trino: Object\.freeze\(\{$[\s\S]*?^ {2}\}\),$/m.exec(sqlTextText)?.[0] ?? "";
      expect(trinoEntry).toContain("readsSqlText: true,");
      writeFileSync(
        sqlText,
        sqlTextText.replace(trinoEntry, trinoEntry.replace("readsSqlText: true,", "readsSqlText: false,")),
      );
      const staleSqlText = run("--check", "--out", dir);
      expect(staleSqlText.exitCode).toBe(1);
      expect(staleSqlText.stderr.toString()).toBe(
        `${sqlText} is not what the engine declarations project\nrun: bun run engines:generate\n`,
      );
      expect(run("--write", "--out", dir).exitCode).toBe(0);
      expect(readFileSync(sqlText, "utf8")).toBe(sqlTextText);
      expect(run("--check", "--out", dir).exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Each run admits every declaration, a fraction of a second; well inside ten times that.
  }, 20000);

  test("bun run engines:generate regenerates an authored connection.fields and connection.dialog change in one run: a placeable field added and a placed one removed", () => {
    const copy = generatingCopy();
    try {
      // The declaration's own dialog places localDataCenter and no longer places or hints authSource.
      const fields = editMongodbDeclaration(copy.root, (dialog) => ({
        ...dialog,
        hints: dialog.hints.filter(({ field }) => field !== "authSource"),
        placement: [{ field: "localDataCenter", where: "open" }],
      }));

      const run = copy.generate();
      expect(run.stderr).not.toContain("refused");
      expect(run.exitCode).toBe(0);

      const directory = path.join(copy.root, ENGINE_DECLARATIONS_DIRECTORY);
      const regenerated = admittedDeclarations(directory);
      const mongodb = regenerated.find((d) => d.id === "mongodb");
      expect(mongodb?.connection.fields).toEqual(fields);
      expect(mongodb?.connection.dialog.placement).toEqual([{ field: "localDataCenter", where: "open" }]);
      expect(mongodb?.connection.dialog.hints.map(({ field }) => field)).not.toContain("authSource");
      expect(readFileSync(path.join(copy.root, ENGINE_CONNECTION_MODULE), "utf8")).toBe(
        renderConnectionTables(projectConnectionTables(regenerated)),
      );
      expect(readFileSync(path.join(copy.root, ENGINE_CONNECTION_FORM_MODULE), "utf8")).toBe(
        renderConnectionForms(projectConnectionForms(regenerated)),
      );
      expect(readFileSync(path.join(copy.root, ENGINE_CONNECTION_FORM_MODULE), "utf8")).not.toBe(
        readFileSync(path.join(ROOT, ENGINE_CONNECTION_FORM_MODULE), "utf8"),
      );
      expect(readFileSync(path.join(copy.root, ENGINE_CONNECTION_FLAGS_MODULE), "utf8")).toBe(
        readFileSync(path.join(ROOT, ENGINE_CONNECTION_FLAGS_MODULE), "utf8"),
      );
      expect(readFileSync(path.join(copy.root, ENGINE_CATALOG_MODULE), "utf8")).toBe(
        readFileSync(path.join(ROOT, ENGINE_CATALOG_MODULE), "utf8"),
      );
      // Every other declaration is the committed one, byte for byte.
      for (const declaration of ADMITTED.filter((d) => d.id !== "mongodb")) {
        const file = `${declaration.id}.json`;
        expect(readFileSync(path.join(directory, file), "utf8")).toBe(readFileSync(path.join(DIRECTORY, file), "utf8"));
      }
    } finally {
      copy.remove();
    }
    // Copying the sources and the three generator runs take a few seconds; well inside ten times that.
  }, 60000);

  test("bun run engines:generate exits 1 with the validator's refusal when Studio's tables do not follow an authored change", () => {
    const copy = generatingCopy();
    try {
      // The authored side drops a host path field from OPC UA's seed-only fields, and Studio's HOST_PATH_FIELDS record
      // still lists it: every generator writes, and the final admission refuses the declaration the run wrote.
      const file = path.join(copy.root, ENGINE_DECLARATIONS_DIRECTORY, "opcua.json");
      const opcua = JSON.parse(readFileSync(file, "utf8"));
      const seedOnly = {
        ...opcua.connection.seedOnly,
        fields: opcua.connection.seedOnly.fields.filter((field: string) => field !== "clientPrivateKeyPath"),
      };
      writeFileSync(file, `${JSON.stringify({ ...opcua, connection: { ...opcua.connection, seedOnly } }, null, 2)}\n`);
      const untracked = copy.generate();
      expect(untracked.exitCode).toBe(1);
      expect(untracked.stderr).toContain(
        "opcua.json is refused by the provider manifest schema: The host path field at /connection/hostPathFields/1 is not one of the engine's seed-only fields.",
      );
    } finally {
      copy.remove();
    }
    // Copying the sources and the three generator runs take a few seconds; well inside ten times that.
  }, 60000);

  test("bun run engines:generate exits 1 with the validator's refusal when an authored change leaves a placeable field unplaced", () => {
    const copy = generatingCopy();
    try {
      // The authored fields add localDataCenter and the authored dialog drops authSource without placing it.
      editMongodbDeclaration(copy.root, (dialog) => ({
        ...dialog,
        hints: dialog.hints.filter(({ field }) => field !== "authSource"),
        placement: [],
      }));
      const refused = copy.generate();
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain(
        "mongodb.json is refused by the provider manifest schema: The placeable field at /connection/fields/6 has no placement in the engine's connection dialog.",
      );
    } finally {
      copy.remove();
    }
    // Copying the sources and the three generator runs take a few seconds; well inside ten times that.
  }, 60000);

  test("bun run engines:generate regenerates an authored connection string change in one run", () => {
    const copy = generatingCopy();
    try {
      const file = path.join(copy.root, ENGINE_DECLARATIONS_DIRECTORY, "postgres.json");
      const committed = JSON.parse(readFileSync(file, "utf8"));
      const formats = ["postgres://", "postgresql://"];
      const connectionString = {
        ...committed.connection.connectionString,
        paste: { ...committed.connection.connectionString.paste, formats },
      };
      writeFileSync(
        file,
        `${JSON.stringify({ ...committed, connection: { ...committed.connection, connectionString } }, null, 2)}\n`,
      );

      const run = copy.generate();
      expect(run.stderr).not.toContain("refused");
      expect(run.exitCode).toBe(0);

      const directory = path.join(copy.root, ENGINE_DECLARATIONS_DIRECTORY);
      const regenerated = admittedDeclarations(directory);
      const postgres = regenerated.find((d) => d.id === "postgres");
      expect(postgres?.connection.connectionString.paste?.formats).toEqual(formats);
      // The declaration's other members are the committed ones: only the authored format list changed.
      expect({
        ...postgres,
        connection: {
          ...postgres?.connection,
          connectionString: {
            ...postgres?.connection.connectionString,
            paste: committed.connection.connectionString.paste,
          },
        },
      }).toEqual(admitted("postgres"));
      expect(readFileSync(path.join(copy.root, ENGINE_CONNECTION_STRING_MODULE), "utf8")).toBe(
        renderConnectionStrings(projectConnectionStrings(regenerated)),
      );
      expect(readFileSync(path.join(copy.root, ENGINE_CONNECTION_STRING_MODULE), "utf8")).not.toBe(
        readFileSync(path.join(ROOT, ENGINE_CONNECTION_STRING_MODULE), "utf8"),
      );
      for (const generated of [
        ENGINE_CATALOG_MODULE,
        ENGINE_CONNECTION_MODULE,
        ENGINE_CONNECTION_FLAGS_MODULE,
        ENGINE_CONNECTION_FORM_MODULE,
        ENGINE_QUERY_EDITOR_MODULE,
      ]) {
        expect(readFileSync(path.join(copy.root, generated), "utf8")).toBe(
          readFileSync(path.join(ROOT, generated), "utf8"),
        );
      }
      // Every other declaration is the committed one, byte for byte.
      for (const declaration of ADMITTED.filter((d) => d.id !== "postgres")) {
        const name = `${declaration.id}.json`;
        expect(readFileSync(path.join(directory, name), "utf8")).toBe(readFileSync(path.join(DIRECTORY, name), "utf8"));
      }
    } finally {
      copy.remove();
    }
    // Copying the sources and the three generator runs take a few seconds; well inside ten times that.
  }, 60000);

  test("bun run engines:generate exits 1 naming the function when a declaration names a connection string function Studio holds none for", () => {
    const copy = generatingCopy();
    try {
      const file = path.join(copy.root, ENGINE_DECLARATIONS_DIRECTORY, "postgres.json");
      const committed = JSON.parse(readFileSync(file, "utf8"));
      const connectionString = { ...committed.connection.connectionString, urlTls: "urlTlsV2" };
      writeFileSync(
        file,
        `${JSON.stringify({ ...committed, connection: { ...committed.connection, connectionString } }, null, 2)}\n`,
      );

      const refused = copy.generate();
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain('postgres names the function "urlTlsV2", which Studio holds no function for.');
    } finally {
      copy.remove();
    }
    // Copying the sources and the generator runs take a few seconds; well inside ten times that.
  }, 60000);

  test("bun run engines:generate regenerates an authored execution UI and fence alias change in one run", () => {
    const copy = generatingCopy();
    try {
      const directory = path.join(copy.root, ENGINE_DECLARATIONS_DIRECTORY);
      const edit = (id: string, editor: (committed: EngineDeclaration["editor"]) => EngineDeclaration["editor"]) => {
        const file = path.join(directory, `${id}.json`);
        const committed = JSON.parse(readFileSync(file, "utf8")) as EngineDeclaration;
        writeFileSync(file, `${JSON.stringify({ ...committed, editor: editor(committed.editor) }, null, 2)}\n`);
      };
      const sentence = "Edited in the declaration: a SQLite read past its timeout is killed.";
      edit("redis", (editor) => ({ ...editor, commitKeyword: "MULTI" }));
      edit("sqlite", (editor) => ({
        ...editor,
        consentDeadline: { chip: editor.consentDeadline?.chip ?? "", sentence },
      }));
      edit("postgres", (editor) => ({ ...editor, fenceAliases: [...editor.fenceAliases, "pgsql2"] }));

      const run = copy.generate();
      expect(run.stderr).not.toContain("refused");
      expect(run.exitCode).toBe(0);

      const regenerated = admittedDeclarations(directory);
      const of = (id: string) => regenerated.find((d) => d.id === id);
      expect(of("redis")?.editor.commitKeyword).toBe("MULTI");
      expect(of("sqlite")?.editor.consentDeadline?.sentence).toBe(sentence);
      expect(of("postgres")?.editor.fenceAliases).toEqual([...admitted("postgres").editor.fenceAliases, "pgsql2"]);
      const editorModule = readFileSync(path.join(copy.root, ENGINE_EDITOR_MODULE), "utf8");
      expect(editorModule).toBe(renderEditorFacts(projectEditorFacts(regenerated)));
      expect(editorModule).toContain('pgsql2: "postgres"');
      expect(editorModule).toContain('commitKeyword: "MULTI"');
      for (const generated of [
        ENGINE_CATALOG_MODULE,
        ENGINE_CONNECTION_MODULE,
        ENGINE_CONNECTION_FLAGS_MODULE,
        ENGINE_CONNECTION_FORM_MODULE,
        ENGINE_CONNECTION_STRING_MODULE,
        ENGINE_QUERY_EDITOR_MODULE,
      ]) {
        expect(readFileSync(path.join(copy.root, generated), "utf8")).toBe(
          readFileSync(path.join(ROOT, generated), "utf8"),
        );
      }
      // Every other declaration is the committed one, byte for byte.
      for (const declaration of ADMITTED.filter((d) => !["postgres", "redis", "sqlite"].includes(d.id))) {
        const name = `${declaration.id}.json`;
        expect(readFileSync(path.join(directory, name), "utf8")).toBe(readFileSync(path.join(DIRECTORY, name), "utf8"));
      }
    } finally {
      copy.remove();
    }
    // Copying the sources and the three generator runs take a few seconds; well inside ten times that.
  }, 60000);

  test("bun run engines:generate exits 1 naming the alias when two declarations state one fence alias", () => {
    const copy = generatingCopy();
    try {
      const file = path.join(copy.root, ENGINE_DECLARATIONS_DIRECTORY, "postgres.json");
      const committed = JSON.parse(readFileSync(file, "utf8")) as EngineDeclaration;
      const editor = { ...committed.editor, fenceAliases: [...committed.editor.fenceAliases, "mariadb"] };
      writeFileSync(file, `${JSON.stringify({ ...committed, editor }, null, 2)}\n`);
      const editorModule = path.join(copy.root, ENGINE_EDITOR_MODULE);
      const before = readFileSync(editorModule, "utf8");

      const refused = copy.generate();
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain('The fence alias "mariadb" is declared by both mysql and postgres.');
      // Refused before any module or declaration is written.
      expect(readFileSync(editorModule, "utf8")).toBe(before);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...committed, editor });
    } finally {
      copy.remove();
    }
    // Copying the sources and the generator run take a few seconds; well inside ten times that.
  }, 60000);

  test("bun run engines:generate regenerates an authored dialect row and editor language change in one run", () => {
    const copy = generatingCopy();
    try {
      const directory = path.join(copy.root, ENGINE_DECLARATIONS_DIRECTORY);
      const edit = (id: string, editor: (committed: EngineDeclaration["editor"]) => EngineDeclaration["editor"]) => {
        const file = path.join(directory, `${id}.json`);
        const committed = JSON.parse(readFileSync(file, "utf8")) as EngineDeclaration;
        const edited = { ...committed, editor: editor(committed.editor) };
        writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`);
        return edited;
      };
      const kafka = edit("kafka", (editor) => ({
        ...editor,
        dialect: { ...(editor.dialect as NonNullable<typeof editor.dialect>), offersCountQuery: true },
      }));
      const milvus = edit("milvus", (editor) => ({
        ...editor,
        language: { ...editor.language, accent: "border-hue-orange/40" },
      }));

      const run = copy.generate();
      expect(run.stderr).not.toContain("refused");
      expect(run.exitCode).toBe(0);

      const regenerated = admittedDeclarations(directory);
      const of = (id: string) => regenerated.find((d) => d.id === id);
      // The declaration generator writes both members back unchanged.
      expect(of("kafka")).toEqual(kafka);
      expect(of("milvus")).toEqual(milvus);
      const queryEditorModule = readFileSync(path.join(copy.root, ENGINE_QUERY_EDITOR_MODULE), "utf8");
      expect(queryEditorModule).toBe(renderQueryEditorFacts(projectQueryEditorFacts(regenerated)));
      expect(queryEditorModule).toContain('milvus: Object.freeze({ accent: "border-hue-orange/40", console: true }),');
      expect(projectQueryEditorFacts(regenerated).queryDialects.kafka?.offersCountQuery).toBe(true);
      for (const generated of [
        ENGINE_CATALOG_MODULE,
        ENGINE_CONNECTION_MODULE,
        ENGINE_CONNECTION_FLAGS_MODULE,
        ENGINE_CONNECTION_FORM_MODULE,
        ENGINE_CONNECTION_STRING_MODULE,
        ENGINE_EDITOR_MODULE,
      ]) {
        expect(readFileSync(path.join(copy.root, generated), "utf8")).toBe(
          readFileSync(path.join(ROOT, generated), "utf8"),
        );
      }
      // Every other declaration is the committed one, byte for byte.
      for (const declaration of ADMITTED.filter((d) => !["kafka", "milvus"].includes(d.id))) {
        const name = `${declaration.id}.json`;
        expect(readFileSync(path.join(directory, name), "utf8")).toBe(readFileSync(path.join(DIRECTORY, name), "utf8"));
      }
    } finally {
      copy.remove();
    }
    // Copying the sources and the three generator runs take a few seconds; well inside ten times that.
  }, 60000);

  test("bun run engines:generate exits 1 naming the editor language when two declarations state it with different accents", () => {
    const copy = generatingCopy();
    try {
      const file = path.join(copy.root, ENGINE_DECLARATIONS_DIRECTORY, "mysql.json");
      const committed = JSON.parse(readFileSync(file, "utf8")) as EngineDeclaration;
      const editor = {
        ...committed.editor,
        language: { ...committed.editor.language, accent: "border-hue-orange/40" },
      };
      writeFileSync(file, `${JSON.stringify({ ...committed, editor }, null, 2)}\n`);
      const queryEditorModule = path.join(copy.root, ENGINE_QUERY_EDITOR_MODULE);
      const before = readFileSync(queryEditorModule, "utf8");

      const refused = copy.generate();
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain(
        'The editor language "sql" is stated with a different accent or console by bigquery and mysql.',
      );
      // Refused before any module or declaration is written.
      expect(readFileSync(queryEditorModule, "utf8")).toBe(before);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...committed, editor });
    } finally {
      copy.remove();
    }
    // Copying the sources and the generator run take a few seconds; well inside ten times that.
  }, 60000);

  test("bun run engines:generate regenerates an authored SQL text change in one run", () => {
    const copy = generatingCopy();
    try {
      const directory = path.join(copy.root, ENGINE_DECLARATIONS_DIRECTORY);
      const edit = (id: string, sqlText: (committed: EngineDeclaration["sqlText"]) => EngineDeclaration["sqlText"]) => {
        const file = path.join(directory, `${id}.json`);
        const committed = JSON.parse(readFileSync(file, "utf8")) as EngineDeclaration;
        const edited = { ...committed, sqlText: sqlText(committed.sqlText) };
        writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`);
        return edited;
      };
      const postgres = edit("postgres", (sqlText) => ({
        ...sqlText,
        grammar: { ...sqlText.grammar, nonNumericRowBounds: [...sqlText.grammar.nonNumericRowBounds, "NONE"] },
      }));
      const mysql = edit("mysql", (sqlText) => ({
        ...sqlText,
        updateTarget: {
          ...sqlText.updateTarget,
          extraQueryOpeners: [...sqlText.updateTarget.extraQueryOpeners, "RETURNING"],
        },
      }));

      const run = copy.generate();
      expect(run.stderr).not.toContain("refused");
      expect(run.exitCode).toBe(0);

      const regenerated = admittedDeclarations(directory);
      const of = (id: string) => regenerated.find((d) => d.id === id);
      // The declaration generator writes the authored members back unchanged.
      expect(of("postgres")).toEqual(postgres);
      expect(of("mysql")).toEqual(mysql);
      const sqlTextModule = readFileSync(path.join(copy.root, ENGINE_SQL_TEXT_MODULE), "utf8");
      expect(sqlTextModule).toBe(renderSqlText(projectSqlText(regenerated)));
      expect(projectSqlText(regenerated).postgres?.grammar.nonNumericRowBounds).toEqual(["ALL", "NONE"]);
      expect(projectSqlText(regenerated).mysql?.updateTarget.extraQueryOpeners).toContain("RETURNING");
      for (const generated of [
        ENGINE_CATALOG_MODULE,
        ENGINE_CONNECTION_MODULE,
        ENGINE_CONNECTION_FLAGS_MODULE,
        ENGINE_CONNECTION_FORM_MODULE,
        ENGINE_CONNECTION_STRING_MODULE,
        ENGINE_EDITOR_MODULE,
        ENGINE_QUERY_EDITOR_MODULE,
      ]) {
        expect(readFileSync(path.join(copy.root, generated), "utf8")).toBe(
          readFileSync(path.join(ROOT, generated), "utf8"),
        );
      }
      // Every other declaration is the committed one, byte for byte.
      for (const declaration of ADMITTED.filter((d) => !["mysql", "postgres"].includes(d.id))) {
        const name = `${declaration.id}.json`;
        expect(readFileSync(path.join(directory, name), "utf8")).toBe(readFileSync(path.join(DIRECTORY, name), "utf8"));
      }
    } finally {
      copy.remove();
    }
    // Copying the sources and the three generator runs take a few seconds; well inside ten times that.
  }, 60000);

  test("bun run engines:generate exits 1 naming the function when a declaration names a SQL grammar function Studio holds none for", () => {
    const copy = generatingCopy();
    try {
      const file = path.join(copy.root, ENGINE_DECLARATIONS_DIRECTORY, "mysql.json");
      const committed = JSON.parse(readFileSync(file, "utf8")) as EngineDeclaration;
      const sqlText = {
        ...committed.sqlText,
        completion: { ...committed.sqlText.completion, formatSegment: "formatSegment" },
      };
      writeFileSync(file, `${JSON.stringify({ ...committed, sqlText }, null, 2)}\n`);

      const refused = copy.generate();
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain('mysql names the function "formatSegment", which Studio holds no function for.');
    } finally {
      copy.remove();
    }
    // Copying the sources and the generator runs take a few seconds; well inside ten times that.
  }, 60000);

  test("SHIPPED_DATABASE_TYPES is the catalog's engines in its order", () => {
    expect<string[]>([...SHIPPED_DATABASE_TYPES]).toEqual(Object.keys(BUNDLED_CATALOG));
    expect([...SHIPPED_DATABASE_TYPES]).toEqual([...SHIPPED_DATABASE_TYPES].sort());
    expect(Object.isFrozen(SHIPPED_DATABASE_TYPES)).toBe(true);
  });

  test("EXTERNAL_DATABASE_TYPES and isExternalDatabaseType answer the location each declaration authors", () => {
    const external = ADMITTED.filter((d) => d.location === "external").map((d) => d.id);

    expect<string[]>([...EXTERNAL_DATABASE_TYPES]).toEqual(external);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => isExternalDatabaseType(type))).toEqual(external as DatabaseType[]);
    expect(ADMITTED.filter((d) => d.location === "embedded").map((d) => d.id)).toEqual(["libredb"]);
    expect(isExternalDatabaseType("libredb")).toBe(false);
    // A value the catalog does not hold is no external engine, prototype keys included.
    for (const value of ["acmefoo", "constructor", "toString", "__proto__"]) {
      expect(isExternalDatabaseType(value as DatabaseType)).toBe(false);
    }
  });
});
