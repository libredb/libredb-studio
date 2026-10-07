import { describe, test, expect } from "bun:test";
import { createDatabaseProvider } from "@/lib/db/factory";
import { declaredKinds, offersTestDataGeneration } from "@/lib/db/object-kinds";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";
import type { DatabaseType } from "@/lib/types";

/**
 * Where Generate Test Data is offered, read from every provider's own declaration (#1468).
 *
 * Before `supportsTestDataGeneration` existed, both row menus offered the generator where the
 * row's kind accepts row writes AND the engine declared `supportsInlineRowEdit`, the results
 * grid's `UPDATE ... SET` flag. That set was measured 2026-10-06 by enumerating every
 * provider's `getCapabilities()`: the eight SQL engines whose table kind takes row writes and
 * whose grid edits rows. The flag kept exactly that set and added MongoDB, whose collection
 * takes the generator's `insertMany` although its grid has no `UPDATE` to emit.
 *
 * A Record so a new member of `DatabaseType` is a compile error here rather than an engine
 * that silently gains or loses the menu item.
 */
const OFFERED: Readonly<Record<DatabaseType, boolean>> = Object.freeze({
  postgres: true,
  mysql: true,
  sqlite: true,
  libsql: true,
  duckdb: true,
  oracle: true,
  db2: true,
  mssql: true,
  mongodb: true,
  clickhouse: false,
  druid: false,
  trino: false,
  cassandra: false,
  elasticsearch: false,
  opensearch: false,
  redis: false,
  couchbase: false,
  libredb: false,
  prometheus: false,
  kafka: false,
  etcd: false,
  neo4j: false,
  milvus: false,
  qdrant: false,
  influxdb: false,
  influxdb3: false,
  oxia: false,
});

const TYPES = Object.keys(OFFERED) as DatabaseType[];

/** Whether ANY kind the provider declares is offered the generator by the menus' own predicate. */
async function offeredOn(type: DatabaseType): Promise<boolean> {
  const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities();
  return declaredKinds(capabilities).some((kind) => offersTestDataGeneration(capabilities, kind.id));
}

describe("supportsTestDataGeneration (#1468)", () => {
  test.each(TYPES)("%s resolves the flag to a boolean", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    // `typeof` because the menus gate on `=== true`, so an absent flag and a declared `false`
    // render the same and only this assertion tells them apart.
    expect(typeof provider.getCapabilities().supportsTestDataGeneration).toBe("boolean");
  });

  test.each(TYPES)("%s is offered Generate Test Data exactly where the census says", async (type) => {
    expect(await offeredOn(type)).toBe(OFFERED[type]);
  });

  test("the offered set is the old grid-edit set plus MongoDB", async () => {
    const offered: DatabaseType[] = [];
    for (const type of TYPES) if (await offeredOn(type)) offered.push(type);
    const expected: DatabaseType[] = [
      "db2",
      "duckdb",
      "libsql",
      "mongodb",
      "mssql",
      "mysql",
      "oracle",
      "postgres",
      "sqlite",
    ];
    expect(offered.sort()).toEqual(expected.sort());
  });
});
