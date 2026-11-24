/**
 * Studio's engine catalog, which engines it ships, where each lives and how long its open may take, and its data-only
 * connection tables, projected from the engine declarations the catalog generator admits (docs/providers/CONTRACT.md,
 * clauses M-70 and M-71).
 *
 * `scripts/generate-engine-catalog.ts` admits every committed declaration through the SDK's digest-checked validator,
 * projects the admitted set with `projectCatalog` and `projectConnectionTables` and renders the projections into
 * `src/lib/db/engine-catalog/catalog.generated.ts` and `connection.generated.ts`, the modules Studio's readers read.
 * This file holds the projections, the admission, the generated modules' bytes and the readers that answer from them.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EngineDeclaration } from "@libredb/provider-sdk/manifest";
import {
  admittedDeclarations,
  ENGINE_CATALOG_MODULE,
  ENGINE_CONNECTION_MODULE,
  ENGINE_DECLARATIONS_DIRECTORY,
  renderCatalog,
  renderConnectionTables,
} from "../../../scripts/generate-engine-catalog";
import { EXTERNAL_DATABASE_TYPES, isExternalDatabaseType, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { BUNDLED_CATALOG } from "@/lib/db/engine-catalog/catalog.generated";
import {
  BUNDLED_CONNECTION_FIELDS,
  BUNDLED_CONNECTION_STRING_ACCEPTED,
  BUNDLED_CREDENTIAL_WARNINGS,
  BUNDLED_DIALOG_OFFERS_URI,
  BUNDLED_READS_TRUST_MATERIAL,
  BUNDLED_REFUSED_FIELDS,
  BUNDLED_SEED_ONLY,
} from "@/lib/db/engine-catalog/connection.generated";
import { type ConnectionTables, projectCatalog, projectConnectionTables } from "@/lib/db/engine-catalog/projection";
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

      writeFileSync(path.join(directory, "kafka.json"), kafka);
      writeFileSync(path.join(directory, "notes.txt"), "kept\n");
      expect(() => admittedDeclarations(directory)).toThrow("notes.txt is not a declaration");

      rmSync(path.join(directory, "notes.txt"));
      writeFileSync(path.join(directory, "acmefoo.json"), "{");
      expect(() => admittedDeclarations(directory)).toThrow(/^acmefoo\.json is not JSON: /);

      rmSync(path.join(directory, "acmefoo.json"));
      expect(admittedDeclarations(directory)).toEqual([...ADMITTED]);
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

  test("the committed connection module is what the generator renders from the admitted declarations", () => {
    const committed = readFileSync(path.join(ROOT, ENGINE_CONNECTION_MODULE), "utf8");
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
    expect(bundled).toEqual(tables);
    // Each record keyed as the projection keys it, in ascending id order.
    for (const name of Object.keys(tables) as (keyof ConnectionTables)[]) {
      expect(Object.keys(bundled[name])).toEqual(Object.keys(tables[name]));
    }
    expect(committed).toContain("bun run engines:generate");
  });

  test("the connection module refuses by name a value it cannot write as the formatter lays it out", () => {
    const tables = projectConnectionTables(ADMITTED);
    const refusal = (text: string) => ({ ...tables, refused: { ...tables.refused, qdrant: { user: text } } });
    const planted = (table: Partial<ConnectionTables>) => () => renderConnectionTables({ ...tables, ...table });

    expect(planted(refusal("A back\\slash."))).toThrow(
      'The connection module cannot write "A back\\\\slash.": it holds',
    );
    expect(planted(refusal("Caf\u00e9."))).toThrow("it holds a character it does not quote");
    expect(planted(refusal("A tab\there."))).toThrow("it holds a character it does not quote");
    expect(planted({ readsTrustMaterial: { ...tables.readsTrustMaterial, "acme-foo": true } })).toThrow(
      'The connection module cannot write the member "acme-foo"',
    );
    expect(planted({ dialogOffersUri: { ...tables.dialogOffersUri, qdrant: 1 as unknown as boolean } })).toThrow(
      "The connection module cannot write 1",
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
      expect(written.stdout.toString()).toBe(`Wrote ${catalog}\nWrote ${connection}\n`);
      expect(readFileSync(connection, "utf8")).toBe(readFileSync(path.join(ROOT, ENGINE_CONNECTION_MODULE), "utf8"));
      expect(readFileSync(catalog, "utf8")).toBe(readFileSync(path.join(ROOT, ENGINE_CATALOG_MODULE), "utf8"));
      const current = run("--check", "--out", dir);
      expect(current.exitCode).toBe(0);
      expect(current.stdout.toString()).toBe(`${catalog} is up to date\n${connection} is up to date\n`);

      const text = readFileSync(connection, "utf8");
      writeFileSync(connection, text.replace("Nothing was sent.", "Nothing at all was sent."));
      const stale = run("--check", "--out", dir);
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr.toString()).toBe(
        `${connection} is not what the engine declarations project\nrun: bun run engines:generate\n`,
      );

      rmSync(connection);
      rmSync(catalog);
      const missing = run("--check", "--out", dir);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr.toString()).toBe(
        `${catalog} is not what the engine declarations project\n${connection} is not what the engine declarations project\nrun: bun run engines:generate\n`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

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
