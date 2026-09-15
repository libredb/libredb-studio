import type { DatabaseConnection } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";

/**
 * One unconnected connection per shipped type-id, shared by the provider censuses.
 *
 * WHY IT LIVES HERE. `tests/isolated/object-edit-declarations.test.ts` used to import this from
 * `tests/isolated/object-source-declarations.test.ts`, which works but makes a TEST file
 * importable by another one: loading the importer registers the census's own suite a second
 * time. Under one bun process per test file that is nine extra tests, each building all
 * seventeen providers through the real `createDatabaseProvider`, run twice and counted twice, so
 * the runner's totals stop matching the suite. Moving the fixture into `tests/helpers/` keeps
 * the single source both censuses need and takes the import out of a test file.
 *
 * Copying it instead was the alternative and it is the worse one: a second seventeen-row
 * `Record<DatabaseType, DatabaseConnection>` goes stale the first time an engine's port moves in
 * only one of them, and the record exists so that a new member of the union is a COMPILE error
 * rather than a missing row. Two records defeat exactly that.
 */

/**
 * The fields every provider's `validate()` demands, none of which is ever dialled.
 *
 * Nothing here connects: `createDatabaseProvider` is a switch over dynamic imports and a
 * constructor, and the constructors validate their configuration without opening a socket or a
 * file. The host is the loopback address and the port is 1 so that a provider which ever did
 * try to dial would fail loudly rather than reach something real.
 */
const UNCONNECTED = {
  id: "census",
  name: "census",
  host: "127.0.0.1",
  port: 1,
  database: "census",
  user: "census",
  password: "census",
  filePath: ":memory:",
  url: "http://127.0.0.1:1",
  connectionString: "mongodb://127.0.0.1:1/census",
  // Cassandra's driver refuses to build a client without one, so the census cannot reach that
  // provider's declarations at all without it. A stock single-node install reports datacenter1.
  localDataCenter: "datacenter1",
  createdAt: new Date(0),
} as const;

const unconnected = (type: DatabaseType): DatabaseConnection => ({ ...UNCONNECTED, type }) as DatabaseConnection;

/**
 * One connection per shipped type-id, as a Record so the compiler owns exhaustiveness.
 *
 * A new member of `DatabaseType` fails to compile here, which is a stronger failure than the
 * runtime one the driven populations in the censuses also give: a census cannot be extended to a
 * new engine by accident, and it cannot skip one either.
 */
export const CENSUS_CONNECTION: Readonly<Record<DatabaseType, DatabaseConnection>> = Object.freeze({
  postgres: unconnected("postgres"),
  mysql: unconnected("mysql"),
  sqlite: unconnected("sqlite"),
  libsql: unconnected("libsql"),
  duckdb: unconnected("duckdb"),
  oracle: unconnected("oracle"),
  mssql: unconnected("mssql"),
  clickhouse: unconnected("clickhouse"),
  druid: unconnected("druid"),
  trino: unconnected("trino"),
  cassandra: unconnected("cassandra"),
  elasticsearch: unconnected("elasticsearch"),
  opensearch: unconnected("opensearch"),
  mongodb: unconnected("mongodb"),
  redis: unconnected("redis"),
  couchbase: unconnected("couchbase"),
  libredb: unconnected("libredb"),
});
