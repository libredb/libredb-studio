/**
 * The connection string registry: one row per shipped type id, each composed from its declaration's connection string
 * (docs/providers/CONTRACT.md, clause M-74) and the functions Studio's connection string function table binds to the
 * names it gives, each the export of that engine's own module beside its provider.
 *
 * The rows are compared here with their source, the declarations and the engine modules; what each row does is held by
 * the golden files, the paste tests, the parser tests and the seed tests, which read the same rows.
 */
import { describe, expect, test } from "bun:test";
import type { EngineDeclaration } from "@libredb/provider-sdk/manifest";
import { admittedDeclarations } from "../../../../scripts/generate-engine-catalog";
import { ENGINE_URI_SCHEMES as PARSER_ENGINE_URI_SCHEMES } from "@/lib/connection-string-parser";
import {
  CONNECTION_STRING,
  CONNECTION_STRING_FUNCTIONS,
  connectionStringFor,
  ENGINE_URI_SCHEMES,
} from "@/lib/db/connection-string";
import { NO_CONNECTION_CONNECTION_STRING } from "@/lib/db/connection-string/no-connection";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import type { DatabaseType } from "@/lib/types";
import { OUTSIDE_THE_UNION, refusalOf, refusalThrownBy } from "../../../helpers/outside-the-union";

/**
 * The module of each engine whose declaration names a connection string function: the flat placements (spec 5.3), and
 * every other one at `<family>/<id>/connection-string.ts`. An engine that names none has no module.
 */
const FLAT: Readonly<Record<string, string>> = {
  postgres: "sql/postgres-connection-string",
  mysql: "sql/mysql-connection-string",
  mssql: "sql/mssql-connection-string",
  oracle: "sql/oracle-connection-string",
  redis: "keyvalue/redis-connection-string",
};

const FAMILIES: Readonly<Record<string, readonly string[]>> = {
  document: ["couchbase", "mongodb"],
  industrial: ["opcua"],
  keyvalue: ["etcd"],
  sql: ["clickhouse", "databend", "db2", "libsql", "snowflake", "spark"],
};

function placement(id: string): string {
  if (FLAT[id]) return FLAT[id];
  const family = Object.keys(FAMILIES).find((name) => FAMILIES[name].includes(id));
  if (!family) throw new Error(`no placement for ${id}`);
  return `${family}/${id}/connection-string`;
}

const ALL: readonly DatabaseType[] = [...EXTERNAL_DATABASE_TYPES, "libredb"];
const sorted = (values: Iterable<string>) => [...values].sort();
const idsWhere = (has: (id: DatabaseType) => boolean) => ALL.filter(has).sort();
const ADMITTED: readonly EngineDeclaration[] = admittedDeclarations();

/** The admitted declaration of `id`. */
function declared(id: string): EngineDeclaration {
  const declaration = ADMITTED.find((d) => d.id === id);
  if (declaration === undefined) throw new Error(`no admitted declaration of ${id}`);
  return declaration;
}

/** The export of each slot kind of the table, named for its engine as `<ID>_<SUFFIX>`. */
const SLOT_EXPORTS = [
  ["urlTlsReaders", "URL_TLS"],
  ["pasteReaders", "PASTE_READER"],
  ["seedChecks", "SEED_CHECK"],
] as const;

/** The exports of each engine's module, keyed by its id, for every engine that has one. */
const EXPORTS: ReadonlyMap<string, Record<string, unknown>> = new Map(
  await Promise.all(
    [...Object.keys(FLAT), ...Object.values(FAMILIES).flat()].map(
      async (id) => [id, (await import(`@/lib/db/providers/${placement(id)}`)) as Record<string, unknown>] as const,
    ),
  ),
);

/** The exports of the module of `id`, or none for an engine without one. */
const moduleOf = (id: string): Record<string, unknown> => EXPORTS.get(id) ?? {};

describe("connection string registry census", () => {
  test("one row per shipped type id", () => {
    expect(Object.keys(CONNECTION_STRING).sort()).toEqual([...ALL].sort());
    expect(Object.isFrozen(CONNECTION_STRING)).toBe(true);
  });

  test("each row is its declaration's connection string composed with Studio's function table", () => {
    for (const id of ALL) {
      const { scheme, urlTls, paste, seedCheck } = declared(id).connection.connectionString;
      const row = CONNECTION_STRING[id];
      const exported = moduleOf(id);
      const prefix = id.toUpperCase();

      expect(Object.keys(row)).toEqual(["scheme", "readTls", "paste", "validateSeed"]);
      expect(Object.isFrozen(row)).toBe(true);
      expect(row.scheme).toBe(scheme);
      expect(row.readTls).toBe(urlTls === null ? null : (exported[`${prefix}_URL_TLS`] as typeof row.readTls));
      expect(row.validateSeed).toBe(
        seedCheck === null ? null : (exported[`${prefix}_SEED_CHECK`] as typeof row.validateSeed),
      );
      if (paste === null) {
        expect(row.paste).toBeNull();
        continue;
      }
      const reader = exported[`${prefix}_PASTE_READER`] as Record<"claims" | "names" | "parse", unknown>;
      expect(Object.keys(row.paste ?? {})).toEqual(["catchAll", "claims", "names", "parse", "formats"]);
      expect(Object.isFrozen(row.paste)).toBe(true);
      expect(row.paste?.catchAll).toBe(paste.catchAll);
      expect(row.paste?.claims).toBe(reader.claims as never);
      expect(row.paste?.names).toBe(reader.names as never);
      expect(row.paste?.parse).toBe(reader.parse as never);
      expect(row.paste?.formats).toEqual(paste.formats);
      expect(Object.isFrozen(row.paste?.formats)).toBe(true);
    }
  });

  test("each function the table binds for an engine is the export of that engine's own module", () => {
    const bound: string[] = [];
    const foreign: string[] = [];
    for (const [kind, suffix] of SLOT_EXPORTS) {
      for (const [id, slots] of Object.entries(CONNECTION_STRING_FUNCTIONS[kind])) {
        const exported = moduleOf(id);
        for (const held of Object.values(slots ?? {})) {
          // Listed by engine and slot, so a function bound under another engine fails naming the engine it is under.
          if (held !== exported[`${id.toUpperCase()}_${suffix}`]) foreign.push(`${id}.${suffix}`);
          bound.push(`${id}.${suffix}`);
        }
      }
    }
    expect(foreign).toEqual([]);
    expect(bound.length).toBe(4 + 13 + 3);
    // Every engine that names a function has a module, and every module is that of an engine that names one.
    expect(sorted(new Set(bound.map((name) => name.split(".")[0] as string)))).toEqual(
      sorted([...Object.keys(FLAT), ...Object.values(FAMILIES).flat()]),
    );
  });

  test("rows are pairwise distinct objects", () => {
    expect(new Set(Object.values(CONNECTION_STRING)).size).toBe(ALL.length);
    const pastes = Object.values(CONNECTION_STRING).flatMap((row) => (row.paste === null ? [] : [row.paste]));
    expect(new Set(pastes).size).toBe(pastes.length);
  });

  test("the scheme, URL TLS and seed check rows are the ones today's code has", () => {
    expect(idsWhere((id) => CONNECTION_STRING[id].scheme !== null)).toEqual([
      "clickhouse",
      "couchbase",
      "databend",
      "db2",
      "libsql",
      "mongodb",
      "mssql",
      "mysql",
      "oracle",
      "postgres",
      "redis",
    ]);
    for (const id of ALL) {
      const scheme = CONNECTION_STRING[id].scheme;
      if (scheme !== null) expect(scheme).toBe(id);
    }
    expect(idsWhere((id) => CONNECTION_STRING[id].readTls !== null)).toEqual(["db2", "mssql", "mysql", "postgres"]);
    expect(idsWhere((id) => CONNECTION_STRING[id].validateSeed !== null)).toEqual(["etcd", "opcua", "snowflake"]);
  });

  test("connectionStringFor answers no connection with its own spec and a type id with its row", () => {
    expect(connectionStringFor(undefined)).toBe(NO_CONNECTION_CONNECTION_STRING);
    expect(NO_CONNECTION_CONNECTION_STRING).toEqual({ scheme: null, readTls: null, paste: null, validateSeed: null });
    expect(connectionStringFor("postgres")).toBe(CONNECTION_STRING.postgres);
  });

  test.each(OUTSIDE_THE_UNION)("connectionStringFor refuses %s by name", (_label, value) => {
    expect(refusalThrownBy(() => connectionStringFor(value as string))).toEqual(refusalOf(value));
  });

  test("the scheme map is derived inside the registry, and the parser re-exports that same object", () => {
    expect(PARSER_ENGINE_URI_SCHEMES).toBe(ENGINE_URI_SCHEMES);
    const withScheme = Object.entries(CONNECTION_STRING).filter(([, spec]) => spec.scheme !== null);
    expect(Object.fromEntries(withScheme.map(([type, spec]) => [type, spec.scheme]))).toEqual(
      ENGINE_URI_SCHEMES as Record<string, string>,
    );
  });
});
