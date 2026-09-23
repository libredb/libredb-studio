/**
 * The fleet census of object COLUMN declarations (#789, columns under an object row).
 *
 * WHY THIS FILE EXISTS. `ObjectKindSpec.hasColumns` decides which object rows get a twisty at
 * all, on every engine, and the decision is per KIND rather than per role: five `config` kinds in
 * the fleet have columns and at least one `relation`-shaped `sequence` has none, which is the
 * measurement that put the fact on the provider instead of in a rule above it. A claim that
 * spreads across sixteen provider files that way is a claim about the BUILD, so it is measured
 * here by building every provider through the REAL `createDatabaseProvider` and reading what each
 * one actually declares.
 *
 * THE TWO HALVES ARE INDEPENDENT OR THIS FILE CERTIFIES NOTHING. `EXPECTED_COLUMN_KINDS` below is
 * transcribed from the design's per-engine declaration table and was committed in wave 1, BEFORE
 * any provider declared anything: at that commit every one of the seventeen rows is red, and that
 * red is the deliverable. The measurement comes from the build. A census that derived its
 * expectation from the build would agree with any declaration whatsoever. When the two disagree,
 * exactly one of them is wrong, and the repair is to the DECLARATION or to the design's table,
 * never to this expectation.
 *
 * THREE PROPERTIES OF THE POPULATION, each inherited from the two censuses beside this file
 * because each has been got wrong at least once:
 *
 * 1. The type-id list is DRIVEN from `EXTERNAL_DATABASE_TYPES` plus the embedded store, never
 *    typed here, so a new engine is censused the day it lands. `CENSUS_CONNECTION`
 *    (`tests/helpers/census-connection.ts`, shared with both other censuses) is a
 *    `Record<DatabaseType, ...>`, so a new member of the union is a COMPILE error rather than a
 *    missing row.
 * 2. `createDatabaseProvider("mysql")` is UNCONNECTED, and mysql is the one provider whose
 *    `objectKinds` is not a constant: `objectKindsFor(undefined)` answers the MySQL six and
 *    structurally EXCLUDES MariaDB's `package` and `sequence`. MariaDB's `sequence` is one of the
 *    five `config` kinds that do have columns, so a census that read only unconnected providers
 *    could not see the declaration it is most likely to get wrong. The branch is driven below.
 * 3. `elasticsearch` and `opensearch` share ONE declaration constant (`SEARCH_OBJECT_KINDS` in
 *    `src/lib/db/providers/sql/search/index.ts`), so a mutation on one of their kinds fails two
 *    rows of this census at once. That is one kill, not two.
 *
 * AND ONE HOLE THIS FILE CLOSES, which neither other census needs. The expectation names kind
 * IDS, and a kind id in the table that no provider declares is silently satisfiable in one
 * direction: the abstainer guard below never reaches a kind that does not exist, so a table naming
 * a kind that was renamed or never existed would leave a row permanently short with nothing saying
 * why. `every kind id the expectation names is declared` runs FIRST and fails by name, which is
 * how the `stream` finding below was produced rather than argued.
 *
 * MEASURED 2026-09-22, and recorded because the repair went the way that rule demands: the
 * binding design's table spelled the search providers' third mapped kind `data_stream`, and the
 * id those providers really declare is `stream` (`SEARCH_KIND_STREAM` at
 * `src/lib/db/providers/sql/search/index.ts:323`, listed in `SEARCH_MAPPED_KINDS` at `:478-482`
 * as the third kind that answers `_mapping`). This file transcribed `data_stream` verbatim first
 * and went red naming both rows, because a census whose expectation is edited to match a build
 * certifies nothing. The DESIGN was then corrected and the expectation re-transcribed from the
 * corrected table. Renaming the provider's kind id would have been the wrong repair: the id is
 * load-bearing in the transport, in both provider docs, in both integration suites and in the
 * source census's own rows.
 *
 * WHAT THIS FILE CANNOT SHARE A PROCESS WITH (#789), measured for
 * `tests/isolated/object-source-declarations.test.ts` and inherited rather than re-argued: it
 * builds providers through the REAL `createDatabaseProvider`, and every file under `tests/api/`
 * mocks `@/lib/db` with a `createDatabaseProvider: mock()` answering undefined, which reaches
 * `@/lib/db/factory` through the index re-export. In a shared process this file would read
 * `provider.getCapabilities` off undefined. The runner gives every test file a bun process of its
 * own, so that isolation is already in force and this paragraph is where the requirement is
 * written down.
 */
import { describe, expect, test } from "bun:test";
import { EXTERNAL_DATABASE_TYPES, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { declaredKinds, findKind, kindHasColumns } from "@/lib/db/object-kinds";
import type { ObjectKindSpec } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../helpers/census-connection";

/**
 * The committed expectation, transcribed from the design's per-engine declaration table, one row
 * per type-id. Everything a row does not name declares nothing.
 *
 * Each row is SORTED before comparison rather than compared in declaration order, which is the
 * shape both other censuses use and is a deliberate weakening: `declaredKinds` answers in the
 * provider's own declaration order, so an order-sensitive comparison would pin the order the kinds
 * appear in a provider's array, which no reader sees and no part of this feature depends on. Druid
 * declares `datasource`, `lookup`, `system_table` and the table writes the row in a different
 * order, and neither spelling is wrong.
 *
 * The mysql row is the MySQL branch ONLY. MariaDB's `sequence` is asserted separately, because an
 * unconnected provider cannot show it at all.
 */
const EXPECTED_COLUMN_KINDS: Readonly<Record<DatabaseType, readonly string[]>> = Object.freeze({
  postgres: ["table", "view", "materialized_view", "sequence"],
  mysql: ["table", "view"],
  oracle: ["table", "view", "materialized_view"],
  mssql: ["table", "view"],
  sqlite: ["table", "view"],
  libsql: ["table", "view"],
  duckdb: ["table", "view"],
  clickhouse: ["table", "view", "materialized_view", "dictionary"],
  trino: ["table", "view", "materialized_view"],
  cassandra: ["table", "materialized_view", "type"],
  druid: ["datasource", "system_table", "lookup"],
  // One declaration constant serves both ids, so these two rows always move together.
  elasticsearch: ["index", "alias", "stream"],
  opensearch: ["index", "alias", "stream"],
  mongodb: ["collection", "view"],
  couchbase: ["collection"],
  redis: ["keyspace"],
  // One kind has columns: a metric, whose columns are its label names, then `timestamp` and
  // `value` (#1085 4.2). Rule groups, rules, scrape pools and targets describe none.
  prometheus: ["metric"],
  libredb: ["table", "collection", "keyspace"],
});

/** The census population: every external engine plus the embedded store. */
const CENSUS_TYPES: readonly DatabaseType[] = [...EXTERNAL_DATABASE_TYPES, "libredb"];

/**
 * The mysql row as a MariaDB server resolves it: the MySQL two plus `sequence`.
 *
 * Transcribed from the same table row, whose third entry reads "MariaDB's `sequence` when the
 * MariaDB branch is driven". A `config` kind with columns, and one of the five the design cites as
 * the reason this fact is not `role === "relation"`.
 */
const MARIADB_COLUMN_KINDS: readonly string[] = Object.freeze(["table", "view", "sequence"]);

/**
 * The flavour a MariaDB server is measured as, which is the derived fact the provider stores once
 * it has read `SELECT VERSION()`.
 *
 * FOURTH OWNER, DISCLOSED RATHER THAN HOISTED, and the three others say the same about each other:
 * `tests/isolated/object-source-declarations.test.ts`, `object-edit-declarations.test.ts` and
 * `monaco-language-ids.test.ts` all carry this constant and the same private-field write, for the
 * same structural reason. Standing ruling 5h says to report a helper about to be written again
 * rather than hoist it while other implementers hold the checkout, and a shared module would be a
 * file this task does not own.
 *
 * No copy can drift in silence: a flavour the provider no longer knows is a type error at the
 * write below, and a write that lands on nothing leaves the MySQL default answering. Here that is
 * the named throw in the MariaDB test, which refuses to compare a row it never reached the extra
 * kind in.
 */
const MARIADB_FLAVOUR = "mariadb";

/** `<type-id>/<kind id>`, the shape the over-declaration guard reports in. */
const pair = (type: DatabaseType, kind: ObjectKindSpec): string => `${type}/${kind.id}`;

/**
 * The whole fleet's declared kinds, in one pass, with the type-id each came from.
 *
 * Nothing is caught here. A provider whose constructor rejects this configuration fails the census
 * by name, which is the correct outcome: a type-id that cannot be built cannot be censused, and
 * pretending otherwise is how a provider goes missing from a count.
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
 * The measured flavour is a PRIVATE field written by `connect()`. It is set directly rather than
 * through a stub of `getCapabilities`, because a stub would return a kind list this test typed,
 * and the whole point of a census is that the code produces the list. Writing the field drives the
 * real `objectKindsFor` branch. If the field is ever renamed, this write lands on nothing, the
 * MySQL default answers, and the named throw below fires rather than the test quietly censusing
 * six kinds and calling the MariaDB branch clean.
 */
async function mariadbKinds(): Promise<readonly ObjectKindSpec[]> {
  const provider = await createDatabaseProvider(CENSUS_CONNECTION.mysql);
  (provider as unknown as { measuredFlavour: "mysql" | "mariadb" }).measuredFlavour = MARIADB_FLAVOUR;
  return declaredKinds(provider.getCapabilities());
}

/** One type-id's measured row: the kind ids whose spec declares columns, sorted. */
function measuredRow(kinds: readonly ObjectKindSpec[]): readonly string[] {
  return kinds
    .filter(kindHasColumns)
    .map((kind) => kind.id)
    .sort();
}

describe("the fleet census of object column declarations", () => {
  test("the census population is the whole shipped fleet, driven and not typed", () => {
    // The population every assertion below iterates. If this were empty or short, each of those
    // loops would certify only the engines it happened to reach, so it is asserted first.
    expect([...CENSUS_TYPES].sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
    expect(CENSUS_TYPES).toHaveLength(18);
    expect(Object.keys(EXPECTED_COLUMN_KINDS).sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
    // A row naming nothing would make its type-id's census pass on the empty set, and the design's
    // table has no such row: every one of the eighteen engines has at least one kind with columns.
    const empty = CENSUS_TYPES.filter((type) => EXPECTED_COLUMN_KINDS[type].length === 0);
    expect(empty).toEqual([]);
  });

  test("every kind id the expectation names is a kind its provider actually declares", async () => {
    // WHY THIS RUNS BEFORE THE CENSUS. The census compares two lists of kind IDS, and a name in
    // the expectation that no provider declares can never be measured: it is simply absent from
    // the filtered row, so the census fails with a one-entry diff that looks exactly like a
    // provider that forgot its declaration. Those are different defects with different owners, and
    // this guard separates them by name before the census runs.
    //
    // The MariaDB row is included, because `sequence` is not a kind an unconnected mysql provider
    // declares at all and a guard that cannot reach a branch does not cover it.
    const unknown: string[] = [];
    let inspected = 0;
    for (const type of CENSUS_TYPES) {
      const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities();
      for (const id of EXPECTED_COLUMN_KINDS[type]) {
        inspected += 1;
        if (findKind(capabilities, id) === undefined) unknown.push(`${type}/${id}`);
      }
    }
    const mariadb = await mariadbKinds();
    for (const id of MARIADB_COLUMN_KINDS) {
      inspected += 1;
      if (!mariadb.some((kind) => kind.id === id)) unknown.push(`mysql(mariadb)/${id}`);
    }
    // The zero-iteration case certifies NOTHING: with no name inspected, `unknown` is empty
    // because nothing was resolved rather than because every name resolves.
    if (inspected === 0) {
      throw new Error("the kind-id guard resolved 0 names, so it certifies nothing about the expectation");
    }
    expect(unknown).toEqual([]);
  });

  test("every type-id declares exactly the kinds the design's table names, and no others", async () => {
    const rows = await censusKinds();
    const visited = new Set(rows.map((row) => row.type));
    // A provider that declared no kind at all would contribute nothing and be invisible in the
    // per-type rows below, so the visit is asserted separately from what was found.
    expect([...visited].sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());

    const measured: Record<string, readonly string[]> = {};
    for (const type of CENSUS_TYPES) {
      measured[type] = measuredRow(rows.filter((row) => row.type === type).map((row) => row.kind));
    }
    const expected: Record<string, readonly string[]> = {};
    for (const type of CENSUS_TYPES) expected[type] = [...EXPECTED_COLUMN_KINDS[type]].sort();
    // ALL SEVENTEEN ROWS IN ONE DIFF, on purpose. Seventeen separate tests would report the same
    // facts, and a per-type comparison inside a loop would die on the first engine and say nothing
    // about the other sixteen. A reader of the red needs the whole fleet's state at once, because
    // the wave that repairs it is sixteen people working in parallel on one file each.
    expect(measured).toEqual(expected);
  });

  test("no kind declares columns that the design's table does not name", async () => {
    // The OVER-declaration direction, which the equality above already fails on but which is a
    // different defect and deserves its own sentence: a kind that gains `hasColumns` it should not
    // have draws a twisty that opens on nothing, for every object of that kind on that engine.
    // Separated because it is also the direction that produced the `stream`/`data_stream` finding
    // in this file's header: a table naming an undeclared kind leaves the equality red while this
    // guard stays meaningful.
    const rows = [
      ...(await censusKinds()),
      ...(await mariadbKinds()).map((kind) => ({ type: "mysql" as const, kind })),
    ];
    if (rows.length === 0) {
      throw new Error("the over-declaration guard inspected 0 kinds, so it certifies nothing about the fleet");
    }
    // The MariaDB half is reached, or this guard covers the MySQL six only.
    if (!rows.some((row) => row.type === "mysql" && row.kind.id === "sequence")) {
      throw new Error("the over-declaration guard never reached mysql/sequence, so it misses the MariaDB branch");
    }
    const permitted = (type: DatabaseType, id: string): boolean =>
      EXPECTED_COLUMN_KINDS[type].includes(id) || (type === "mysql" && MARIADB_COLUMN_KINDS.includes(id));
    const unexpected = rows
      .filter((row) => kindHasColumns(row.kind) && !permitted(row.type, row.kind.id))
      .map((row) => pair(row.type, row.kind));
    expect(unexpected).toEqual([]);
  });

  test("the MariaDB branch declares one more, which an unconnected provider cannot show", async () => {
    const unconnected = declaredKinds((await createDatabaseProvider(CENSUS_CONNECTION.mysql)).getCapabilities());
    const mariadb = await mariadbKinds();

    // The control: the branch really did resolve a different kind set, so the assertion below is a
    // fact about MariaDB's own kinds and not a value the unconnected read would have given.
    const extras = mariadb.filter((kind) => !unconnected.some((other) => other.id === kind.id)).map((kind) => kind.id);
    if (extras.length === 0) {
      throw new Error(
        `the MariaDB branch resolved the same kinds as the unconnected provider, so the measured flavour ${MARIADB_FLAVOUR} ` +
          "no longer reaches it and this test certifies nothing",
      );
    }
    expect(extras.sort()).toEqual(["package", "sequence"]);

    expect(measuredRow(mariadb)).toEqual([...MARIADB_COLUMN_KINDS].sort());
    // Both halves by name rather than by count: `sequence` is the only one of MariaDB's two extra
    // kinds that has columns, and `package` gaining the declaration would otherwise only move a
    // length.
    expect(measuredRow(unconnected)).toEqual([...EXPECTED_COLUMN_KINDS.mysql].sort());
  });
});
