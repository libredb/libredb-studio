/**
 * The fleet census of object source declarations (#789).
 *
 * WHY THIS FILE EXISTS, and it is a lesson rather than a convention. Phase 1 of the object
 * model wrote "all seventeen providers implement the method" into every task brief without
 * re-measuring it, and it was FALSE: two providers never got the method, and the conformance
 * guard's own early return hid the gap because a provider that answers `undefined` was simply
 * skipped. A number typed by a person is not a measurement. So the count of kinds across the
 * fleet that declare a readable definition is produced HERE, by building every provider through
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
 *    omitted. `CENSUS_CONNECTION` (`tests/helpers/census-connection.ts`, shared with the edit
 *    census) is a `Record<DatabaseType, ...>`, so a new member of the union is a COMPILE error
 *    rather than a missing row.
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
 * WHAT THIS FILE CANNOT SHARE A PROCESS WITH (#789). It builds providers through the REAL
 * `createDatabaseProvider`, which is the whole point: a declaration census that read a double
 * would certify the double. Every file under `tests/api/` mocks `@/lib/db` with a
 * `createDatabaseProvider: mock()` answering undefined, and that mock reaches
 * `@/lib/db/factory` through the index re-export, so in a shared process this file reads
 * `provider.getCapabilities` off undefined. Measured 2026-09-13: alone it is green; beside
 * `tests/api/db-objects.test.ts` it is not. Nothing this file can do prevents it, because
 * mocking the factory is what the api layer is for. The runner gives every test file a bun
 * process of its own, so that isolation is already in force and this paragraph, rather than a
 * directory or an entry in a runner script, is where the requirement is written down.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { TreeRowModel } from "@/components/object-tree/flatten";
import { rowActions, type TreeRowActionHandlers } from "@/components/object-tree/row-actions";
import { EXTERNAL_DATABASE_TYPES, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { declaredKinds, findKind } from "@/lib/db/object-kinds";
import type { DatabaseObject, ObjectKindSpec, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../helpers/census-connection";

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
  // Every kind has a source, and every source is JSON the provider serialises from the API's own
  // answer, under the `rendered` origin (#1085 4.4).
  prometheus: [
    "metric/json",
    "rule_group/json",
    "recording_rule/json",
    "alerting_rule/json",
    "scrape_pool/json",
    "target/json",
  ],
  // Every kind has a source, JSON the provider serialises from the broker's own answers, under the
  // `rendered` origin (#1088 4.4).
  kafka: ["topic/json", "consumer_group/json", "broker/json"],
  libredb: [],
});

/** The census population: every external engine plus the embedded store. */
const CENSUS_TYPES: readonly DatabaseType[] = [...EXTERNAL_DATABASE_TYPES, "libredb"];

/** The committed expectation, flattened to the `<type-id>/<kind id>/<sourceLanguage>` triples. */
const UNCONNECTED_SOURCE_KINDS: readonly string[] = CENSUS_TYPES.flatMap((type) =>
  SOURCE_DECLARATIONS[type].map((entry) => `${type}/${entry}`),
).sort();

/**
 * The type-ids that implement no `readObjectSource` at all, committed rather than derived.
 *
 * Deriving it from `SOURCE_DECLARATIONS` would make the population assertion below agree with any
 * declaration whatsoever, which is the same independence the census keeps between its two halves.
 * It is also the third thing a new provider has to move, and `docs/ADDING_A_PROVIDER.md` says so:
 * the guard below asserts that the shipped checklist names every member of this list.
 */
const CENSUS_ABSTAINERS: readonly DatabaseType[] = Object.freeze(["druid", "libredb"]);

/** MariaDB's two extra kinds, which arrive only once the flavour has been measured. */
const MARIADB_EXTRA_SOURCE_KINDS: readonly string[] = ["mysql/package/mysql", "mysql/sequence/mysql"];

/**
 * The flavour a MariaDB server is measured as, which is the derived fact the provider stores
 * once it has read `SELECT VERSION()`.
 *
 * SECOND OWNER, DISCLOSED RATHER THAN HOISTED. `tests/isolated/monaco-language-ids.test.ts`
 * carries the same constant and the same private-field write, for the same structural reason: an
 * unconnected mysql provider answers the MySQL six and both files need the MariaDB two. Standing
 * ruling 5h says to report a helper about to be written again rather than hoist it while another
 * implementer holds the checkout, and a shared module would be a third file this task does not
 * own, so the two copies stay and this note is the pointer between them.
 *
 * Neither copy can drift in SILENCE, measured in fix round 1: a flavour the provider no longer
 * knows is a type error at the write, and a write that lands on nothing leaves the MySQL default
 * answering. Here that is the named throw in the half-declaration guard plus the MariaDB triple
 * set; there it is `toContain("mysql/package")`.
 */
const MARIADB_FLAVOUR = "mariadb";

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
 * `objectKindsFor` resolves the kind set from the flavour the server was measured as, and that
 * flavour is a PRIVATE field written by `connect()`. It is set here directly rather than through
 * a stub of `getCapabilities`, because a stub would return a kind list this test typed, and the
 * whole point of a census is that the code produces the list. Writing the field drives the real
 * `objectKindsFor` branch. If the field is ever renamed, this write lands on nothing, the MySQL
 * default answers, and every caller below fails by name rather than quietly censusing six kinds.
 */
async function mariadbKinds(): Promise<readonly CensusRow[]> {
  const provider = await createDatabaseProvider(CENSUS_CONNECTION.mysql);
  (provider as unknown as { measuredFlavour: "mysql" | "mariadb" }).measuredFlavour = MARIADB_FLAVOUR;
  return declaredKinds(provider.getCapabilities()).map((kind) => ({ type: "mysql" as const, kind }));
}

const triple = (type: DatabaseType, kind: ObjectKindSpec): string => `${type}/${kind.id}/${kind.sourceLanguage ?? "-"}`;

describe("the fleet census of object source declarations", () => {
  test("the census population is the whole shipped fleet, driven and not typed", () => {
    // The population every assertion below iterates. If this were empty or short, each of those
    // loops would certify only the engines it happened to reach, so it is asserted first.
    expect([...CENSUS_TYPES].sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
    expect(CENSUS_TYPES).toHaveLength(19);
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
    expect(UNCONNECTED_SOURCE_KINDS).toHaveLength(67);
    expect(rows.filter((row) => row.kind.hasSource === true)).toHaveLength(67);
    expect(rows.filter((row) => row.kind.hasSource !== true)).toHaveLength(22);
    expect(rows).toHaveLength(89);
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
    // 69 on a MariaDB connection against 67 unconnected: the design states both numbers because
    // criterion 2's evidence method reads an unconnected provider and would otherwise
    // structurally exclude the two riskiest declarations in the phase.
    expect(UNCONNECTED_SOURCE_KINDS.length + MARIADB_EXTRA_SOURCE_KINDS.length).toBe(69);
  });

  /*
    THE PAIRING, WHICH THE CENSUS PINNED NOWHERE UNTIL THE EXTERNAL REVIEW OF PR #820 (#789).

    Everything above this test reads DECLARATIONS. A kind can declare `hasSource` with no
    `readObjectSource` behind it, which is Phase 1's exact hole in its Phase 2 spelling: the row
    menu offers View Source, the route resolves the kind, and the read then lands on a method the
    provider never implemented. The only guard that saw it was `assertObjectSurface`, which needs
    a LIVE ENGINE, so on a machine with no containers the guard did not exist at all, and a CI
    job that skips the integration engines is that machine.

    The relation is a BICONDITIONAL, and both directions are real defects rather than one defect
    and one tidiness rule:

    - a method with no source-bearing kind is a reader nothing can reach, so the method is either
      dead or the declaration that fed it was deleted;
    - a source-bearing kind with no method is a Source tab that fails at the read.

    Both were mutated. With `hasSource` stripped from redis's `function`, the first arm fails by
    name; with `hasSource: true` added to a druid kind, the second does. The numbers are in the
    task report.
  */
  test("a type-id declares source-bearing kinds if and only if it implements readObjectSource", async () => {
    const implementers: string[] = [];
    const abstainers: string[] = [];
    const mismatches: string[] = [];
    for (const type of CENSUS_TYPES) {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      const sourceKinds = declaredKinds(provider.getCapabilities()).filter((kind) => kind.hasSource === true);
      // `typeof` on the built provider and not `"readObjectSource" in provider`: the property is
      // optional on the interface, so an `in` test walks the prototype chain and would answer
      // true for anything the base class ever grows under that name.
      const implemented = typeof provider.readObjectSource === "function";
      (implemented ? implementers : abstainers).push(type);
      if (implemented !== sourceKinds.length > 0) {
        mismatches.push(
          `${type}: ${sourceKinds.length} source-bearing kind(s) and readObjectSource is ` +
            `${implemented ? "implemented" : "absent"}`,
        );
      }
    }
    // The zero-iteration case of the loop above certifies NOTHING: with no type-id censused,
    // `mismatches` is empty because nothing was compared rather than because the fleet agrees. The
    // population assertions below do fail on it, but they fail on an expect diff that names
    // neither the loop nor the fact that nothing was read, so the loop refuses it by name first.
    if (implementers.length + abstainers.length === 0) {
      throw new Error("the pairing guard censused 0 type-ids, so it certifies nothing about the fleet");
    }
    expect(mismatches).toEqual([]);

    // THE POPULATION, asserted rather than assumed, because a biconditional is satisfied by a
    // population that holds only one side of it. A run that reached no abstainer certifies
    // nothing about the "declares source with no method" direction, and a run that reached no
    // implementer certifies nothing about the other.
    expect([...implementers].sort()).toEqual(
      CENSUS_TYPES.filter((type) => SOURCE_DECLARATIONS[type].length > 0)
        .map((type) => String(type))
        .sort(),
    );
    // Druid and the embedded store are the fleet's two abstainers, and both are deliberate: each
    // provider doc records what its engine publishes instead of a definition text.
    expect([...abstainers].sort()).toEqual([...CENSUS_ABSTAINERS].map(String).sort());
    expect(implementers.length + abstainers.length).toBe(CENSUS_TYPES.length);
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
    expect(rows).toHaveLength(97);

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

/**
 * THE OTHER HALF OF THE QA NEGATIVE, AND WHY IT LIVES BESIDE THE CENSUS (#789).
 *
 * The browser round for Phase 2 was asked to show that a row whose kind declares no definition
 * offers no "View Source". On most engines that is read off an OPEN menu, and a screenshot of the
 * open menu is evidence anybody can look at. On four rows in the fleet the negative is one step
 * stronger and one step harder to photograph: the row has NO actions at all, so the tree draws no
 * ellipsis trigger and announces no `aria-haspopup`, and the trigger it does not draw is one that
 * only paints on the hovered or selected row anyway. A screenshot of a row with nothing on it and
 * a screenshot of a row whose trigger is merely unhovered are the same picture.
 *
 * So that claim was carried by prose about a DOM query run against a container that has since been
 * removed, which standing ruling 5i says is not evidence. This is the same claim as a derivation
 * from the shipped declarations, which anybody can re-run: `ObjectTree`'s `hasRowMenu` is
 * `actionsFor(row).length > 0` and nothing else, so a kind whose row yields an empty action list
 * is exactly a row with no trigger.
 *
 * TWO WAYS THIS COULD CERTIFY NOTHING, and the control below kills both. `rowActions` answers `[]`
 * for a kind the provider does not declare, and it answers `[]` for an object row whose object is
 * absent, so an empty list is the value this assertion would get from a typo in a kind id or from
 * a fixture that forgot the object. Every entry therefore names a SIBLING kind on the same
 * provider whose row must yield a NON-EMPTY list, built by the same helper from the same handlers
 * and the same object shape. A run where the handlers went missing, the object went missing or the
 * capabilities came back empty fails on the control rather than passing on the negative.
 */
interface ZeroActionRow {
  readonly type: DatabaseType;
  /** The kind the QA round recorded as carrying no menu trigger at all. */
  readonly kind: string;
  /** A kind on the SAME provider that must carry one, so an empty list cannot be an accident. */
  readonly control: string;
}

/**
 * The four rows the standalone browser round recorded as carrying no trigger, with the engine and
 * the screenshot each was recorded on: postgres `sequence` (round 1), cassandra `trigger` (18),
 * couchbase `index` (27) and druid `lookup` (19). Not a derived list: it is transcribed from what
 * a person saw, and the point of the test is that the build agrees with it.
 */
const ZERO_ACTION_ROWS: readonly ZeroActionRow[] = Object.freeze([
  { type: "postgres", kind: "sequence", control: "function" },
  { type: "cassandra", kind: "trigger", control: "function" },
  { type: "couchbase", kind: "index", control: "function" },
  { type: "druid", kind: "lookup", control: "datasource" },
]);

/** Everything the standalone shell passes, so a missing action is the DECLARATION, not the shell. */
function everyHandler(): TreeRowActionHandlers {
  return {
    onGenerateSelect: () => {},
    onProfileObject: () => {},
    onGenerateCode: () => {},
    onGenerateTestData: () => {},
    onOpenMaintenance: () => {},
    onCreateObject: () => {},
    onViewSource: () => {},
  };
}

/** One object row of the named kind, built the way `flatten.ts` builds one, and its action ids. */
function rowMenuIds(capabilities: ProviderCapabilities, kindId: string): readonly string[] {
  const path = ["census_container", "census_object"];
  const object: DatabaseObject = { path, name: "census_object", kind: kindId };
  const row: TreeRowModel = {
    id: `census_container/census_object/${kindId}`,
    kind: "object",
    label: "census_object",
    depth: 2,
    setSize: 1,
    posInSet: 1,
    path,
    kindId,
  };
  return rowActions({ row, object, capabilities, handlers: everyHandler() }).map((action) => action.id);
}

describe("the rows a person saw carrying no menu trigger", () => {
  test("carry none from the shipped declarations, each beside a sibling that carries one", async () => {
    // The zero-iteration case of the loop below certifies nothing about any engine, so it is
    // refused by name rather than passing quietly.
    if (ZERO_ACTION_ROWS.length === 0) {
      throw new Error("the row-menu negative inspected 0 rows, so it certifies nothing about the fleet");
    }

    const drivenNegatives: string[] = [];
    for (const entry of ZERO_ACTION_ROWS) {
      const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION[entry.type])).getCapabilities();
      // An undeclared kind draws no folder and no row, so an empty menu for one is not the
      // negative the brief asks for. Both names are resolved against the declaration first.
      if (findKind(capabilities, entry.kind) === undefined) {
        throw new Error(`${entry.type} declares no ${entry.kind} kind, so an empty row menu says nothing about it`);
      }
      if (findKind(capabilities, entry.control) === undefined) {
        throw new Error(`${entry.type} declares no ${entry.control} kind, so the control cannot run`);
      }
      expect(rowMenuIds(capabilities, entry.kind)).toEqual([]);
      expect(rowMenuIds(capabilities, entry.control).length).toBeGreaterThan(0);
      drivenNegatives.push(`${entry.type}/${entry.kind}`);
    }
    expect(drivenNegatives).toEqual(ZERO_ACTION_ROWS.map((entry) => `${entry.type}/${entry.kind}`));
  });

  test("the two engines that declare no source anywhere offer View Source on no kind at all", async () => {
    // Druid and libredb are the fleet's whole-engine negative: with every folder expanded the
    // browser found the string "View Source" nowhere in the document. Here that is every declared
    // kind's menu, so a future kind gaining `hasSource` on either engine fails by name.
    for (const type of ["druid", "libredb"] as const) {
      const capabilities = (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities();
      const kinds = declaredKinds(capabilities);
      if (kinds.length === 0) {
        throw new Error(`${type} declared no kinds, so "no kind offers View Source" is vacuously true`);
      }
      const offering = kinds.filter((kind) => rowMenuIds(capabilities, kind.id).includes("view-source"));
      expect(offering.map((kind) => `${type}/${kind.id}`)).toEqual([]);
      // The control: these rows are not actionless, they simply have no source. An engine whose
      // menus all came back empty would satisfy the assertion above for the wrong reason.
      expect(kinds.filter((kind) => rowMenuIds(capabilities, kind.id).length > 0).length).toBeGreaterThan(0);
    }
  });
});

/**
 * THE SHIPPED CHECKLIST AND THIS CENSUS, held to the same account (#789).
 *
 * `docs/ADDING_A_PROVIDER.md` is the file a new contributor follows, and it is the only place in
 * the repository that describes `readObjectSource` to somebody who has not read the interface. It
 * shipped this method inside the sentence "None can be omitted, but a method whose data your engine
 * does not expose returns a neutral value rather than throwing", which is false for exactly this
 * method and is refuted by the pairing test above: `DatabaseProvider.readObjectSource` is OPTIONAL,
 * an engine that publishes no definition text omits it entirely, and a contributor who followed
 * that sentence would implement a neutral-valued method, declare no `hasSource` kind, and fail the
 * pairing by name with no idea why. An empty text is a RAISE here and never a neutral value.
 *
 * Prose cannot be type-checked, so the two claims a wrong checklist would make are pinned instead:
 * the omission sentence does not cover this method, and the section that does describe it names
 * every type-id the pairing test commits as an abstainer, which is the third thing a new provider
 * has to move and which the checklist did not mention at all.
 *
 * Both guards refuse their own vacuity by name: a doc that lost the omission sentence, or a
 * section heading that was renamed, would otherwise satisfy a `not.toMatch` for free.
 */
const CHECKLIST = "docs/ADDING_A_PROVIDER.md";

const checklistText = (): string => readFileSync(path.join(path.resolve(import.meta.dir, "../.."), CHECKLIST), "utf8");

/** The five object methods the interface really does require, as the checklist spells them. */
const REQUIRED_OBJECT_METHODS: readonly string[] = Object.freeze([
  "listContainers",
  "countObjects",
  "listObjects",
  "describeObject",
  "describeObjects",
]);

describe("the new-provider checklist agrees with the pairing this file enforces", () => {
  test("the omission sentence does not cover readObjectSource, which is optional", () => {
    const paragraphs = checklistText()
      .split(/\n\s*\n/)
      .filter((paragraph) => /\bcan be omitted\b/.test(paragraph));
    // Vacuity, by name: a renamed or deleted sentence would leave nothing to assert against and
    // every `not.toMatch` below would pass on an empty population.
    if (paragraphs.length === 0) {
      throw new Error(`${CHECKLIST} carries no "can be omitted" sentence, so this guard certifies nothing`);
    }
    for (const paragraph of paragraphs) {
      // The control: this really is the method list, not some other sentence that reuses the words.
      for (const required of REQUIRED_OBJECT_METHODS) {
        expect(paragraph, `${CHECKLIST}: the omission sentence no longer lists ${required}`).toContain(required);
      }
      expect(
        paragraph,
        `${CHECKLIST}: the omission sentence covers the one object method that IS optional`,
      ).not.toContain("readObjectSource");
    }
  });

  test("the readObjectSource section names every type-id this file commits as an abstainer", () => {
    const section = /### `readObjectSource`[\s\S]*?(?=\n### |\n## )/.exec(checklistText());
    if (section === null) {
      throw new Error(`${CHECKLIST} has no \`readObjectSource\` section, so this guard certifies nothing`);
    }
    if (CENSUS_ABSTAINERS.length === 0) {
      throw new Error("the census commits no abstainer, so naming them in the checklist certifies nothing");
    }
    for (const abstainer of CENSUS_ABSTAINERS) {
      expect(section[0], `${CHECKLIST}: the checklist does not name ${abstainer} among the abstainers`).toContain(
        abstainer,
      );
    }
    // The list a new abstainer has to join lives in this file, so the checklist has to say its
    // name. Without this the third thing to update is discoverable only by failing the census.
    expect(section[0], `${CHECKLIST}: the checklist never sends a new abstainer to this file`).toContain(
      "object-source-declarations",
    );
  });
});
