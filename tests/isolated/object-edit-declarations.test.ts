/**
 * The fleet census of object EDIT declarations (#789 Phase 3).
 *
 * WHY THIS FILE EXISTS. Phase 3 makes four (type-id, kind) pairs editable and leaves fourteen
 * type-ids declaring nothing, and both halves are claims about the BUILD. The expectation they
 * are measured against is `tests/helpers/object-edit-expectation.ts`, committed in wave 1 before
 * any provider declared anything and transcribed from the design's day-one table. It was never
 * derived from a declaration, and that independence is the whole value of a census: one that
 * derived its expectation from the build would agree with any declaration whatsoever. When the
 * two disagree, exactly one of them is wrong, and the repair is to the DECLARATION or to the
 * design, never to the expectation.
 *
 * WHAT IT CANNOT SHARE A PROCESS WITH, which is the same thing the Phase 2 source census cannot
 * and is measured rather than inherited: it builds every provider through the REAL
 * `createDatabaseProvider`, and every file under `tests/api/` mocks `@/lib/db` with a
 * `createDatabaseProvider: mock()` answering undefined, which reaches `@/lib/db/factory` through
 * the index re-export. In a shared process this file would read `provider.getCapabilities` off
 * undefined. The runner gives every test file a bun process of its own, so that isolation is
 * already in force and this paragraph is where the requirement is written down.
 *
 * `CENSUS_CONNECTION` comes from `tests/helpers/census-connection.ts`, which both censuses
 * import. It used to be imported from the source census itself, which works and costs the run
 * that census twice: importing a TEST file registers its suite in this process too, so
 * `bun test ./tests/isolated/object-edit-declarations.test.ts` reported fifteen tests where this
 * file declares six, each of the nine strays building all seventeen providers a second time.
 * Under one bun process per test file that double count is in every run. Copying the record
 * instead was the other option and it is the worse one: a second seventeen-row
 * `Record<DatabaseType, DatabaseConnection>` goes stale the first time an engine's port moves in
 * only one of them, and the record exists so a new member of the union is a compile error rather
 * than a missing row, which two records defeat exactly.
 *
 * THE MARIADB LEVER, and it is measured rather than a worry. `createDatabaseProvider("mysql")`
 * is UNCONNECTED, and mysql is the one provider whose `objectKinds` is not a constant:
 * `objectKindsFor(undefined)` answers the MySQL six and structurally EXCLUDES MariaDB's
 * `package` and `sequence`. A census that never drove the MariaDB branch could certify that
 * nothing on mysql accepts an edit while the branch a real MariaDB server resolves declared one.
 * The branch is driven below the same way the Phase 2 census drives it, by writing the private
 * `measuredServerVersion` field that `connect()` writes.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createDatabaseProvider } from "@/lib/db/factory";
import { declaredKinds } from "@/lib/db/object-kinds";
import type { DatabaseProvider, ObjectKindSpec } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import {
  EDIT_CENSUS_TYPES,
  EXPECTED_EDITABLE_KINDS,
  EXPECTED_EDIT_ABSTAINERS,
} from "../helpers/object-edit-expectation";
import { CENSUS_CONNECTION } from "../helpers/census-connection";

/**
 * The version string a MariaDB server answers `SELECT VERSION()` with, measured on
 * `mariadb:latest` (12.3.2) by the mysql provider task on 2026-09-11.
 *
 * THIRD OWNER, DISCLOSED RATHER THAN HOISTED, and the two others say the same about each other:
 * `tests/isolated/object-source-declarations.test.ts` and
 * `tests/isolated/monaco-language-ids.test.ts` both carry this constant and the same private
 * field write, for the same structural reason. Standing ruling 5h says to report a helper about
 * to be written again rather than hoist it while another implementer holds the checkout, and a
 * shared module would be a file this task does not own.
 *
 * No copy can drift in silence: a string that stops matching `objectKindsFor`'s `/mariadb/i`
 * makes its own file go red by name. Here it is the named throw in the MariaDB test, which
 * refuses to compare an editable set it never reached the two extra kinds in.
 */
const MARIADB_VERSION_STRING = "12.3.2-MariaDB-ubu2404";

/** `<type-id>/<kind id>`, the shape both halves of the expectation are compared in. */
const pair = (type: DatabaseType, kind: ObjectKindSpec): string => `${type}/${kind.id}`;

/** The committed expectation, flattened to the same shape the measurement produces. */
const EXPECTED_PAIRS: readonly string[] = EXPECTED_EDITABLE_KINDS.map(([type, kind]) => `${type}/${kind}`);

/**
 * The mysql provider's kinds as a MariaDB server resolves them, which no unconnected read shows.
 *
 * The measured version is a PRIVATE field written by `connect()`. It is set directly rather than
 * through a stub of `getCapabilities`, because a stub would return a kind list this test typed,
 * and the whole point of a census is that the code produces the list. Writing the field drives
 * the real `objectKindsFor` branch. If the field is ever renamed, this write lands on nothing,
 * the MySQL default answers, and the named throw below fires rather than the test quietly
 * censusing six kinds and calling the MariaDB branch clean.
 */
async function mariadbKinds(): Promise<readonly ObjectKindSpec[]> {
  const provider = await createDatabaseProvider(CENSUS_CONNECTION.mysql);
  (provider as unknown as { measuredServerVersion: string | undefined }).measuredServerVersion = MARIADB_VERSION_STRING;
  return declaredKinds(provider.getCapabilities());
}

/**
 * Both edit methods, tested with `typeof` and never with `in`.
 *
 * An `in` test walks the prototype chain and would answer true for anything `BaseDatabaseProvider`
 * or `SQLBaseProvider` ever grows under either name, so the biconditional below would start
 * agreeing with a base class rather than with the provider that declared the kind.
 */
const implementsBothEditMethods = (provider: DatabaseProvider): boolean =>
  typeof provider.buildObjectEdit === "function" && typeof provider.applyObjectEdit === "function";

/** The repository root, from this file's own location, so the doc read below is cwd-independent. */
const ROOT = path.resolve(import.meta.dir, "../..");

/**
 * A markdown HEADING line whose text ends in `Object edit (#789)`, at any level and with any
 * trailing clause after it, which two of the fourteen carry (`druid.md` and `libredb.md` both
 * continue the heading with "nothing to write"). Anchored to `^#` so a mention of the phrase in a
 * paragraph, or in a link, cannot satisfy the guard.
 */
const EDIT_SECTION_HEADING = /^#{1,6} .*Object edit \(#789\)/m;

describe("the fleet census of object edit declarations", () => {
  test("exactly four (type-id, kind) pairs declare acceptsSourceEdits", async () => {
    const measured: string[] = [];
    for (const type of EDIT_CENSUS_TYPES) {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      for (const kind of declaredKinds(provider.getCapabilities())) {
        if (kind.acceptsSourceEdits === true) measured.push(pair(type, kind));
      }
    }
    // The zero-iteration refusal, BY NAME and before any `expect` runs. With no type-id censused,
    // `measured` is empty because nothing was read rather than because the fleet declares
    // nothing, and the comparison below would then fail on a diff that names neither the loop nor
    // the fact that the population was empty.
    if (EDIT_CENSUS_TYPES.length === 0) {
      throw new Error("the census read 0 type-ids, so it certifies nothing about the fleet");
    }
    // The expectation is COMMITTED, transcribed from the design's day-one table, and never derived
    // from the build: a census that derived its expectation from the build would agree with any
    // declaration whatsoever.
    expect(measured.sort()).toEqual([...EXPECTED_PAIRS].sort());
  });

  test("the ABSTAINERS are asserted as a population, not as whatever is left", async () => {
    const declaring: string[] = [];
    const abstaining: string[] = [];
    for (const type of EDIT_CENSUS_TYPES) {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      const editable = declaredKinds(provider.getCapabilities()).filter((kind) => kind.acceptsSourceEdits === true);
      (editable.length > 0 ? declaring : abstaining).push(type);
    }
    if (declaring.length + abstaining.length === 0) {
      throw new Error("the abstainer census read 0 type-ids, so it certifies nothing about the fleet");
    }
    // A biconditional is satisfied by a population holding only one side of it, so the fourteen
    // are asserted as their own committed list and the three declaring ids are asserted beside
    // them. A run that reached no abstainer would certify nothing about the absence half.
    expect(abstaining.sort()).toEqual([...EXPECTED_EDIT_ABSTAINERS].map(String).sort());
    expect(declaring.sort()).toEqual([...new Set(EXPECTED_EDITABLE_KINDS.map(([type]) => String(type)))].sort());
    expect(declaring.length + abstaining.length).toBe(EDIT_CENSUS_TYPES.length);
  });

  test("a type-id declares an editable kind IF AND ONLY IF it implements BOTH methods", async () => {
    const implementers: string[] = [];
    const abstainers: string[] = [];
    const mismatches: string[] = [];
    for (const type of EDIT_CENSUS_TYPES) {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      const editable = declaredKinds(provider.getCapabilities()).filter((kind) => kind.acceptsSourceEdits === true);
      // `typeof provider.buildObjectEdit === "function"` and never `"buildObjectEdit" in provider`:
      // an `in` test walks the prototype chain and would answer true for anything the base class
      // ever grows under that name.
      const implemented = implementsBothEditMethods(provider);
      (implemented ? implementers : abstainers).push(type);
      if (implemented !== editable.length > 0) {
        mismatches.push(
          `${type}: ${editable.length} editable kind(s), buildObjectEdit is ` +
            `${typeof provider.buildObjectEdit === "function" ? "implemented" : "absent"} and applyObjectEdit is ` +
            `${typeof provider.applyObjectEdit === "function" ? "implemented" : "absent"}`,
        );
      }
    }
    // The zero-iteration case certifies NOTHING: with no type-id censused, `mismatches` is empty
    // because nothing was compared. Refused by name before the comparison.
    if (implementers.length + abstainers.length === 0) {
      throw new Error("the edit pairing guard censused 0 type-ids, so it certifies nothing about the fleet");
    }
    expect(mismatches).toEqual([]);
    // Both populations, not just the mismatch list: a fleet where nothing implemented either
    // method would produce an empty `mismatches` and satisfy nothing.
    expect(implementers.sort()).toEqual([...new Set(EXPECTED_EDITABLE_KINDS.map(([type]) => String(type)))].sort());
    expect(abstainers.sort()).toEqual([...EXPECTED_EDIT_ABSTAINERS].map(String).sort());
    expect(implementers.length + abstainers.length).toBe(EDIT_CENSUS_TYPES.length);
  });

  test("no kind declares acceptsSourceEdits without hasSource, which every other gate is blind to", async () => {
    // A kind with an edit declaration and no source declaration would have no tab to edit in, and
    // nothing else in this repository can see it: the row menu never offers View Source, the route
    // refuses the kind, and no other gate goes red.
    //
    // The population is the unconnected fleet PLUS the MariaDB branch, for the same reason the
    // Phase 2 half-declaration guard grew its MariaDB half: a guard that cannot reach a branch
    // does not cover it.
    const rows: { readonly type: DatabaseType; readonly kind: ObjectKindSpec }[] = [];
    for (const type of EDIT_CENSUS_TYPES) {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      for (const kind of declaredKinds(provider.getCapabilities())) rows.push({ type, kind });
    }
    for (const kind of await mariadbKinds()) rows.push({ type: "mysql", kind });
    if (rows.length === 0) {
      throw new Error("the half-declaration guard inspected 0 kinds, so it certifies nothing about the fleet");
    }
    for (const extra of ["package", "sequence"]) {
      if (!rows.some((row) => row.type === "mysql" && row.kind.id === extra)) {
        throw new Error(`the half-declaration guard never reached mysql/${extra}, so it misses the MariaDB branch`);
      }
    }

    const halfDeclarations = rows
      .filter((row) => row.kind.acceptsSourceEdits === true && row.kind.hasSource !== true)
      .map((row) => pair(row.type, row.kind));
    expect(halfDeclarations).toEqual([]);
  });

  test("every abstainer's provider doc carries the Object edit (#789) section naming its absence", () => {
    // WHY THIS IS A TEST AND NOT PROSE. Each of the fourteen abstainer sections ends by saying
    // that THIS FILE is what holds that absence and that section together. Without this guard
    // that sentence was false in one direction: the census pinned the DECLARATION half only, so a
    // seventeenth external engine landing as an abstainer would grow
    // `EXPECTED_EDIT_ABSTAINERS`, pass the census with its new id, and ship with no section
    // written anywhere, and nothing in this repository would go red. The population this iterates
    // is the committed abstainer list, which is the same list the census above compares the
    // measured abstainers against, so the two halves cannot drift apart.
    //
    // It asserts the SECTION EXISTS at that id's own doc, not what it says: prose content has no
    // truth value a test can read. What it does buy is that a new absence cannot be shipped
    // silent.
    if (EXPECTED_EDIT_ABSTAINERS.length === 0) {
      throw new Error("the doc-section guard read 0 abstainers, so it certifies nothing about the fourteen sections");
    }
    const missing: string[] = [];
    for (const type of EXPECTED_EDIT_ABSTAINERS) {
      const relative = `docs/providers/${type}.md`;
      const absolute = path.join(ROOT, relative);
      if (!existsSync(absolute)) {
        missing.push(`${relative} does not exist`);
        continue;
      }
      if (!EDIT_SECTION_HEADING.test(readFileSync(absolute, "utf8"))) {
        missing.push(`${relative} carries no "Object edit (#789)" heading`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the MariaDB branch is censused separately, because an unconnected mysql provider answers the MySQL six", async () => {
    // `objectKindsFor(undefined)` structurally excludes MariaDB's `package` and `sequence`, so a
    // census that read only unconnected providers could not see them at all.
    const unconnected = declaredKinds((await createDatabaseProvider(CENSUS_CONNECTION.mysql)).getCapabilities());
    const mariadb = await mariadbKinds();
    // The control: the branch really did resolve a different kind set, so the assertion below is
    // a fact about MariaDB's own kinds and not a value the unconnected read would have given.
    const extras = mariadb.filter((kind) => !unconnected.some((other) => other.id === kind.id)).map((kind) => kind.id);
    if (extras.length === 0) {
      throw new Error(
        `the MariaDB branch resolved the same kinds as the unconnected provider, so ${MARIADB_VERSION_STRING} ` +
          "no longer reaches it and this test certifies nothing",
      );
    }
    expect(extras.sort()).toEqual(["package", "sequence"]);

    const mariadbEditableKinds = mariadb.filter((kind) => kind.acceptsSourceEdits === true).map((kind) => kind.id);
    expect(mariadbEditableKinds).toEqual([]);
  });
});
