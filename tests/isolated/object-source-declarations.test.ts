/**
 * The fleet census of object source declarations (#789).
 *
 * WHY THIS FILE EXISTS, and it is a lesson rather than a convention. Phase 1 of the object
 * model wrote "all seventeen providers implement the method" into every task brief without
 * re-measuring it, and it was FALSE: two providers never got the method, and the conformance
 * guard's own early return hid the gap because a provider that answers `undefined` was simply
 * skipped. A number typed by a person is not a measurement. So the claim "58 kinds across the
 * fleet declare a readable definition" is produced HERE, by building every provider through
 * `createDatabaseProvider` and reading what each one actually declares, and compared against
 * an expectation committed from the design's own table.
 *
 * The two halves must stay independent or the census certifies nothing. The expectation below
 * is transcribed from the Phase 2 design's kind-declaration table, one row per type-id; the
 * measurement comes from the build. A census that derived its expectation from the build would
 * agree with any declaration whatsoever. When the two disagree, exactly one of them is wrong,
 * and the repair is to the DECLARATION or to the design, never to this expectation.
 *
 * THREE PROPERTIES OF THE POPULATION, each of which has been got wrong at least once:
 *
 * 1. The type-id list is DRIVEN from `EXTERNAL_DATABASE_TYPES` plus the embedded store, never
 *    typed here, so a new engine is censused the day it lands rather than being silently
 *    omitted. `CENSUS_CONNECTION` is a `Record<DatabaseType, ...>`, so a new member of the
 *    union is a COMPILE error rather than a missing row.
 * 2. `createDatabaseProvider("mysql")` is UNCONNECTED, and mysql is the one provider whose
 *    `objectKinds` is not a constant: `objectKindsFor(undefined)` answers the MySQL six and
 *    structurally excludes MariaDB's `package` and `sequence`, which the design flags as the
 *    two riskiest declarations in the phase. A census that read only unconnected providers
 *    could not see them at all, so the MariaDB branch is driven separately below.
 * 3. `elasticsearch` and `opensearch` share ONE declaration constant (`SEARCH_OBJECT_KINDS` in
 *    `src/lib/db/providers/sql/search/index.ts`), so a mutation on one of their kinds fails two
 *    rows of the census at once. That is one kill, not two, and nobody should read it as two.
 *
 * AND ONE HOLE THIS FILE CLOSES, found while the last providers landed. `assertObjectSurface`
 * filters the fleet's source assertions on `hasSource === true`, so a kind carrying a
 * `sourceLanguage` with NO `hasSource` is invisible to every other gate in this repository:
 * the row menu never offers View Source, the route refuses the kind, and nothing goes red.
 *
 * MEASURED TWICE, and it is stronger than the first wording of this paragraph said. That wording
 * claimed a half declaration "fails only that provider's own local declaration assertion", which
 * is false: it fails NOTHING outside this file's guards. Two mutants, each run against the whole
 * of `tests/unit` and diffed against a baseline of the same run, when this file still lived there:
 *
 * - `sourceLanguage: "sql"` added to mssql's `table` with no `hasSource`: the failure set grew by
 *   exactly two lines, this file's `no kind declares a sourceLanguage without hasSource` and
 *   the membership guard in `monaco-language-ids.test.ts`, which moved beside this file. No
 *   mssql assertion fired.
 * - `sourceLanguage: "pgsql"` added to postgres's `table`: the same two lines and nothing else.
 *
 * The provider suites cannot see it by construction: each one's local pairing assertion maps
 * `hasSource === true` kinds to `[id, sourceLanguage]` and the OTHER direction to bare kind ids,
 * so a kind that gained only a language moves in neither list. This file is the only place that
 * sees every provider's declarations at once, so the half-declaration guard lives here, and it is
 * not a duplicate of anything: deleting it makes the class invisible again.
 *
 * WHY THIS FILE LIVES UNDER `tests/isolated/` (#789). It builds providers through the REAL
 * `createDatabaseProvider`, which is the whole point: a declaration census that read a double
 * would certify the double. Every file under `tests/api/` mocks `@/lib/db` with a
 * `createDatabaseProvider: mock()` answering undefined, and that mock reaches
 * `@/lib/db/factory` through the index re-export, so in a shared process this file reads
 * `provider.getCapabilities` off undefined. Measured 2026-09-13: alone it is green; beside
 * `tests/api/db-objects.test.ts` it is not. Nothing this file can do prevents it, because
 * mocking the factory is what the api layer is for, so the isolation sits here and
 * `tests/run-components.sh` gives it a group of its own.
 */
import { describe, expect, test } from "bun:test";
import { EXTERNAL_DATABASE_TYPES, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { declaredKinds } from "@/lib/db/object-kinds";
import type { DatabaseConnection, ObjectKindSpec } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";

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
 * runtime one the driven population below also gives: the census cannot be extended to a new
 * engine by accident, and it cannot skip one either.
 */
const CENSUS_CONNECTION: Readonly<Record<DatabaseType, DatabaseConnection>> = Object.freeze({
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

/**
 * The committed expectation, transcribed from the design's kind-declaration table, one entry
 * per type-id, each `<kind id>/<sourceLanguage>`.
 *
 * The two empty arrays are DECLARATIONS and not omissions. Druid publishes no `CREATE` text for
 * a datasource or a system table at all, and its lookups live behind a Coordinator REST API this
 * provider's transport does not reach; the embedded store has no view, routine, trigger or index
 * anywhere in its export surface. Both were measured rather than assumed, and both provider docs
 * say so.
 *
 * `plsql`, `tsql` and `cql` are absent on purpose: they are not language ids the installed editor
 * registers, so Oracle, SQL Server and Cassandra render under `sql`. That fact is guarded, from
 * the installed bundle rather than from this comment, in `tests/isolated/monaco-language-ids.test.ts`.
 */
const SOURCE_DECLARATIONS: Readonly<Record<DatabaseType, readonly string[]>> = Object.freeze({
  postgres: ["view/pgsql", "materialized_view/pgsql", "function/pgsql", "procedure/pgsql", "trigger/pgsql"],
  // The MySQL branch only. MariaDB's two extra kinds are asserted separately, because an
  // unconnected provider cannot show them.
  mysql: ["table/mysql", "view/mysql", "procedure/mysql", "function/mysql", "trigger/mysql", "event/mysql"],
  sqlite: ["table/sql", "view/sql", "index/sql", "trigger/sql"],
  libsql: ["table/sql", "view/sql", "index/sql", "trigger/sql"],
  duckdb: ["table/sql", "view/sql", "sequence/sql", "macro/sql"],
  oracle: [
    "table/sql",
    "view/sql",
    "materialized_view/sql",
    "synonym/sql",
    "sequence/sql",
    "package/sql",
    "procedure/sql",
    "function/sql",
    "trigger/sql",
  ],
  mssql: ["view/sql", "procedure/sql", "function/sql", "trigger/sql"],
  clickhouse: ["table/sql", "view/sql", "materialized_view/sql", "dictionary/sql", "function/sql"],
  druid: [],
  trino: ["table/sql", "view/sql", "materialized_view/sql", "function/sql"],
  cassandra: ["table/sql", "materialized_view/sql", "index/sql", "type/sql", "function/sql", "aggregate/sql"],
  // One declaration constant serves both ids, so these two rows always move together.
  elasticsearch: ["pipeline/json", "template/json"],
  opensearch: ["pipeline/json", "template/json"],
  mongodb: ["view/json"],
  redis: ["function/lua"],
  couchbase: ["function/sql"],
  libredb: [],
});

/** The census population: every external engine plus the embedded store. */
const CENSUS_TYPES: readonly DatabaseType[] = [...EXTERNAL_DATABASE_TYPES, "libredb"];

/** The committed expectation, flattened to the `<type-id>/<kind id>/<sourceLanguage>` triples. */
const UNCONNECTED_SOURCE_KINDS: readonly string[] = CENSUS_TYPES.flatMap((type) =>
  SOURCE_DECLARATIONS[type].map((entry) => `${type}/${entry}`),
).sort();

/** MariaDB's two extra kinds, which arrive only once `VERSION()` has been measured. */
const MARIADB_EXTRA_SOURCE_KINDS: readonly string[] = ["mysql/package/mysql", "mysql/sequence/mysql"];

/**
 * The version string a MariaDB server answers `SELECT VERSION()` with, measured on
 * `mariadb:latest` (12.3.2) by the mysql provider task on 2026-09-11.
 *
 * SECOND OWNER, DISCLOSED RATHER THAN HOISTED. `tests/isolated/monaco-language-ids.test.ts`
 * carries the same constant and the same private-field write, for the same structural reason: an
 * unconnected mysql provider answers the MySQL six and both files need the MariaDB two. Standing
 * ruling 5h says to report a helper about to be written again rather than hoist it while another
 * implementer holds the checkout, and a shared module would be a third file this task does not
 * own, so the two copies stay and this note is the pointer between them.
 *
 * Neither copy can drift in SILENCE, measured in fix round 1: a string that stops matching
 * `objectKindsFor`'s `/mariadb/i` makes its own file go red by name. Here it is the named throw in
 * the half-declaration guard plus the MariaDB triple set; there it is `toContain("mysql/package")`.
 */
const MARIADB_VERSION_STRING = "12.3.2-MariaDB-ubu2404";

/**
 * The whole fleet's declared kinds, in one pass, with the type-id each came from.
 *
 * Nothing is caught here. A provider whose constructor rejects this configuration fails the
 * census by name, which is the correct outcome: a type-id that cannot be built cannot be
 * censused, and pretending otherwise is how a provider goes missing from a count.
 */
type CensusRow = { readonly type: DatabaseType; readonly kind: ObjectKindSpec };

async function censusKinds(): Promise<readonly CensusRow[]> {
  const rows: CensusRow[] = [];
  for (const type of CENSUS_TYPES) {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    for (const kind of declaredKinds(provider.getCapabilities())) rows.push({ type, kind });
  }
  return rows;
}

/**
 * The mysql provider's kinds as a MariaDB server resolves them, which no unconnected read shows.
 *
 * `objectKindsFor` resolves the kind set from what the server called itself, and the measured
 * version is a PRIVATE field written by `connect()`. It is set here directly rather than through
 * a stub of `getCapabilities`, because a stub would return a kind list this test typed, and the
 * whole point of a census is that the code produces the list. Writing the field drives the real
 * `objectKindsFor` branch. If the field is ever renamed, this write lands on nothing, the MySQL
 * default answers, and every caller below fails by name rather than quietly censusing six kinds.
 */
async function mariadbKinds(): Promise<readonly CensusRow[]> {
  const provider = await createDatabaseProvider(CENSUS_CONNECTION.mysql);
  (provider as unknown as { measuredServerVersion: string | undefined }).measuredServerVersion = MARIADB_VERSION_STRING;
  return declaredKinds(provider.getCapabilities()).map((kind) => ({ type: "mysql" as const, kind }));
}

const triple = (type: DatabaseType, kind: ObjectKindSpec): string => `${type}/${kind.id}/${kind.sourceLanguage ?? "-"}`;

describe("the fleet census of object source declarations", () => {
  test("the census population is the whole shipped fleet, driven and not typed", () => {
    // The population every assertion below iterates. If this were empty or short, each of those
    // loops would certify only the engines it happened to reach, so it is asserted first.
    expect([...CENSUS_TYPES].sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
    expect(CENSUS_TYPES).toHaveLength(17);
    expect(Object.keys(SOURCE_DECLARATIONS).sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
  });

  test("every declared source-bearing kind is exactly the committed set, both directions", async () => {
    const rows = await censusKinds();
    const visited = new Set(rows.map((row) => row.type));
    // A provider that declared no kind at all would contribute nothing and be invisible in the
    // triple list, so the visit is asserted separately from what was found.
    expect([...visited].sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());

    const seen = rows.filter((row) => row.kind.hasSource === true).map((row) => triple(row.type, row.kind));
    expect(seen.sort()).toEqual([...UNCONNECTED_SOURCE_KINDS].sort());

    // The design's own counting, committed as three numbers rather than one. A kind that loses
    // `hasSource` moves between the two halves, so both halves must be pinned or the total alone
    // would still be satisfied. Neither half may be edited to match a build: if this fails, the
    // DECLARATION is wrong or the design's table is, and the repair is one of those two.
    expect(UNCONNECTED_SOURCE_KINDS).toHaveLength(58);
    expect(rows.filter((row) => row.kind.hasSource === true)).toHaveLength(58);
    expect(rows.filter((row) => row.kind.hasSource !== true)).toHaveLength(22);
    expect(rows).toHaveLength(80);
  });

  test("the MariaDB branch declares two more, which an unconnected provider cannot show", async () => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION.mysql);
    const unconnectedTriples = declaredKinds(provider.getCapabilities()).map((kind) => triple("mysql", kind));
    const mariadbRows = await mariadbKinds();
    const mariadbTriples = mariadbRows.map((row) => triple(row.type, row.kind));

    // The control: the two extra kinds are genuinely absent before the version is measured, so
    // the assertion below is a difference the branch made and not a value that was always there.
    for (const extra of MARIADB_EXTRA_SOURCE_KINDS) expect(unconnectedTriples).not.toContain(extra);
    expect(mariadbTriples.sort()).toEqual([...unconnectedTriples, ...MARIADB_EXTRA_SOURCE_KINDS].sort());

    // Both halves by NAME rather than by count. MEASURED: with only the count assertions below,
    // stripping `hasSource` from MariaDB's `sequence` while leaving its `sourceLanguage` in place
    // died as "Expected length: 8, Received length: 7", which names neither the kind nor the
    // defect. The two named sets kill the same mutant saying which kind moved and which way.
    expect(mariadbRows.filter((row) => row.kind.hasSource === true).map((row) => triple(row.type, row.kind))).toEqual([
      ...SOURCE_DECLARATIONS.mysql.map((entry) => `mysql/${entry}`),
      ...MARIADB_EXTRA_SOURCE_KINDS,
    ]);
    expect(mariadbRows.filter((row) => row.kind.hasSource !== true).map((row) => triple(row.type, row.kind))).toEqual(
      [],
    );
    expect(mariadbRows.filter((row) => row.kind.hasSource === true)).toHaveLength(8);
    // 60 on a MariaDB connection against 58 unconnected: the design states both numbers because
    // criterion 2's evidence method reads an unconnected provider and would otherwise
    // structurally exclude the two riskiest declarations in the phase.
    expect(UNCONNECTED_SOURCE_KINDS.length + MARIADB_EXTRA_SOURCE_KINDS.length).toBe(60);
  });

  test("no kind declares a sourceLanguage without hasSource, which every other gate is blind to", async () => {
    // The population is the unconnected fleet PLUS the MariaDB branch, and the second half is
    // here because of a mutation this task ran rather than because of a worry. MEASURED: with the
    // guard reading `censusKinds()` alone, stripping `hasSource` from MariaDB's `sequence` while
    // leaving its `sourceLanguage` produced exactly the half declaration this guard exists to
    // catch, and the guard did not see it, because an unconnected mysql provider answers the
    // MySQL six. A guard that cannot reach a branch does not cover it.
    const rows = [...(await censusKinds()), ...(await mariadbKinds())];
    // The zero-iteration case of this loop certifies NOTHING, and the failure it would hide is
    // silent by construction, so it is refused by name rather than passing quietly. The same
    // applies to a population that lost the MariaDB half: it would still be non-empty.
    if (rows.length === 0) {
      throw new Error("the half-declaration guard inspected 0 kinds, so it certifies nothing about the fleet");
    }
    for (const extra of MARIADB_EXTRA_SOURCE_KINDS) {
      if (!rows.map((row) => triple(row.type, row.kind)).includes(extra)) {
        throw new Error(`the half-declaration guard never reached ${extra}, so it does not cover the MariaDB branch`);
      }
    }
    expect(rows).toHaveLength(88);

    const halfDeclared = rows
      .filter((row) => row.kind.sourceLanguage !== undefined && row.kind.hasSource !== true)
      .map((row) => triple(row.type, row.kind));
    expect(halfDeclared).toEqual([]);

    // The other half of the pairing, which the triple list already fails on but which is worth
    // naming: a kind claiming a definition without saying what language to render it in would
    // reach the viewer with no language at all.
    const languageless = rows
      .filter((row) => row.kind.hasSource === true && row.kind.sourceLanguage === undefined)
      .map((row) => triple(row.type, row.kind));
    expect(languageless).toEqual([]);
  });
});
