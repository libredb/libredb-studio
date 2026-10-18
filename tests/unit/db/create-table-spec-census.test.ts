import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { CreateTableSpec } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { DUCKDB_CREATE_TABLE } from "@/lib/db/providers/sql/duckdb/create-table";
import { MSSQL_CREATE_TABLE } from "@/lib/db/providers/sql/mssql-create-table";
import { MYSQL_CREATE_TABLE } from "@/lib/db/providers/sql/mysql-create-table";
import { ORACLE_CREATE_TABLE } from "@/lib/db/providers/sql/oracle-create-table";
import { POSTGRES_CREATE_TABLE } from "@/lib/db/providers/sql/postgres-create-table";
import { SQLITE_CREATE_TABLE } from "@/lib/db/providers/sql/sqlite-create-table";
import { TRINO_CREATE_TABLE } from "@/lib/db/providers/sql/trino/create-table";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/**
 * Every provider's `createTable` declaration, and every declared grammar against its own invariants and its doc (#1822).
 *
 * `createTable` is what puts the Create Table form, the object-tree "Create <kind>" item and the import into a new
 * table in front of an engine, and its value is the grammar the form writes. A provider that declares none offers
 * none of the three, so the set of declaring ids is a product decision this file holds to a closed list.
 *
 * Nothing here connects: `createDatabaseProvider` is a switch over dynamic imports and a constructor, and
 * `getCapabilities()` is plain data, so the census runs against `CENSUS_CONNECTION`'s unconnected configurations.
 */

const ROOT = join(import.meta.dir, "..", "..", "..");

/** The eight ids that declare a grammar, each with the driver-free constant it returns. libsql embeds SQLite. */
const DECLARED: Readonly<Partial<Record<DatabaseType, CreateTableSpec>>> = Object.freeze({
  postgres: POSTGRES_CREATE_TABLE,
  mysql: MYSQL_CREATE_TABLE,
  mssql: MSSQL_CREATE_TABLE,
  oracle: ORACLE_CREATE_TABLE,
  sqlite: SQLITE_CREATE_TABLE,
  libsql: SQLITE_CREATE_TABLE,
  duckdb: DUCKDB_CREATE_TABLE,
  trino: TRINO_CREATE_TABLE,
});

const ALL_TYPES = Object.keys(CENSUS_CONNECTION) as DatabaseType[];
const DECLARING_TYPES = Object.keys(DECLARED) as DatabaseType[];

/** The lines of `docs/providers/<id>.md` under its "Create Table form" heading, up to the next heading as deep. */
function createTableSection(type: DatabaseType): string | undefined {
  const lines = readFileSync(join(ROOT, "docs", "providers", `${type}.md`), "utf8").split("\n");
  const start = lines.findIndex((line) => /^#{1,6} Create Table form\s*$/.test(line));
  if (start === -1) return undefined;
  const depth = (/^#+/.exec(lines[start]) as RegExpExecArray)[0].length;
  const end = lines.findIndex((line, index) => index > start && new RegExp(`^#{1,${depth}} `).test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

describe("createTable census (#1822)", () => {
  test("exactly the eight ids with a measured grammar declare one", async () => {
    const providers = await Promise.all(ALL_TYPES.map((type) => createDatabaseProvider(CENSUS_CONNECTION[type])));
    const declaring = ALL_TYPES.filter((_, index) => providers[index].getCapabilities().createTable !== undefined);
    expect(declaring.sort()).toEqual([...DECLARING_TYPES].sort());
  });

  test.each(DECLARING_TYPES)("%s returns its own module's constant, the same object", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    expect(provider.getCapabilities().createTable).toBe(DECLARED[type] as CreateTableSpec);
  });

  test("sqlite and libsql share one object, by import and never by a type-id branch", () => {
    expect(DECLARED.libsql).toBe(SQLITE_CREATE_TABLE);
    expect(DECLARED.sqlite).toBe(SQLITE_CREATE_TABLE);
  });
});

describe.each(Object.entries(DECLARED) as [DatabaseType, CreateTableSpec][])("the %s grammar", (type, spec) => {
  test("lists at least one type and no type twice", () => {
    expect(spec.types.length).toBeGreaterThan(0);
    expect(new Set(spec.types).size).toBe(spec.types.length);
  });

  test("keyType is one of its types, or the dropdown trigger renders empty", () => {
    expect(spec.types).toContain(spec.keyType);
  });

  test("an auto-increment clause carries PRIMARY KEY and needs the constraints it implies", () => {
    if (spec.autoIncrement === undefined) return;
    expect(spec.autoIncrement.clause).toContain("PRIMARY KEY");
    expect(spec.columnConstraints).toBe(true);
  });

  test("is plain data that survives the JSON trip to the browser", () => {
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);
  });

  test("its doc has a Create Table form section naming every type and the auto-increment clause", () => {
    const section = createTableSection(type);
    expect(section, `docs/providers/${type}.md has no "Create Table form" heading`).toBeDefined();
    for (const name of spec.types) expect(section, `${type}: ${name}`).toContain(name);
    if (spec.autoIncrement !== undefined) expect(section).toContain(spec.autoIncrement.clause);
  });
});
