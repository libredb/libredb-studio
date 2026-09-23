/**
 * The language guard: every declared `sourceLanguage` is an id the installed editor registers (#789).
 *
 * WHAT GOES WRONG WITHOUT THIS, and it is silent. `ObjectKindSpec.sourceLanguage` is handed
 * straight to Monaco as a model language. Monaco does not raise on an id it never registered: it
 * falls back to plaintext, so a Source tab opens, shows the definition, and is simply not
 * highlighted. Nothing goes red, and no provider suite can catch it, because a provider suite
 * asserts the string its own declaration carries. Only a check against the INSTALLED bundle can.
 *
 * THE VACUITY TRAP THIS FILE IS BUILT AROUND, because the obvious spelling of the guard asserts a
 * value it typed itself. The ids come from two places and not one:
 *
 * - The 89 BASIC languages are registered by one call per language inside
 *   `basic-languages/monaco.contribution.js`. `sql`, `pgsql`, `mysql`, `lua` and `redis` are all
 *   there, and `plsql`, `tsql` and `cql` are NOT, which is the whole reason Oracle, SQL Server and
 *   Cassandra declare `sql` rather than their own dialect.
 * - The four RICH languages (`css`, `html`, `json`, `typescript`) are separate worker-backed
 *   modules under `vs/language/`, each giving its id a full language service rather than the
 *   tokenizer a basic contribution registers. Three of those four ids are ALSO registered by the
 *   basic contribution, and `json` IS THE ONE THAT IS NOT: measured on 0.56.0, of the 89 basic ids
 *   `css`, `html` and `typescript` are present and `json` is absent. That single absence is the
 *   whole reason the rich half of this guard is load-bearing, because `json` is the declared
 *   language of five source-bearing kinds across the two search products and MongoDB, and a guard
 *   that extracted only the 89 would report all five as unregistered.
 *
 *   CORRECTED IN FIX ROUND 1 AND THE OLD WORDING IS RECORDED HERE ON PURPOSE. This paragraph
 *   previously said all four rich ids were absent from the 89, which is false for three of them.
 *   A maintainer who checked that sentence, found `css` in `basic`, and concluded the paragraph
 *   was wrong about the mechanism could delete the `readdirSync` half, which silently unregisters
 *   `json` and un-guards those five kinds. The four `basic.has(...)` assertions in the first test
 *   below now pin each of the four ids individually, so the sentence cannot go stale again in
 *   silence: a monaco bump that moves any of them fails here rather than in prose.
 *
 * So both sets are EXTRACTED from their own location, and the extraction is proved non-empty and
 * proved to contain what it should BEFORE any membership assertion runs.
 *
 * WHY THIS READS `node_modules/monaco-editor/min/vs` AND NOT THE SERVED COPY. The plan's snippet
 * said `public/monaco/vs/language`. MEASURED, and the plan is wrong: `/public/monaco/` is
 * gitignored (`.gitignore:30`) and is produced by `scripts/copy-monaco.mjs`, which is wired into
 * the `dev` and `build` scripts only. The CI test job runs `bun run test:coverage` with no staging
 * step, so on a fresh checkout that directory does not exist and a test reading it would either
 * fail in CI or be written to skip and pass vacuously. `stageMonacoAssets` copies
 * `node_modules/monaco-editor/min/vs` verbatim into `public/monaco/vs`, and the two copies of the
 * contribution file were measured byte-identical with `cmp`, so the package directory is the same
 * bundle one step earlier and it is the one that is always on disk after `bun install`.
 *
 * Measured on monaco-editor 0.56.0, 2026-09-13: 89 basic ids, 4 rich ids, and exactly one of the
 * four rich ids (`json`) absent from the 89.
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
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { declaredKinds } from "@/lib/db/object-kinds";
import type { DatabaseConnection } from "@/lib/db/types";
import { PROMQL_LANGUAGE_ID } from "@/lib/editor/promql-language";
import type { DatabaseType } from "@/lib/types";

/**
 * The installed package, located through the resolver rather than by spelling out a path.
 *
 * `"node_modules/monaco-editor"` is relative to the cwd, and both reads below run at MODULE
 * scope: a process that did not start in the repo root fails this file with ENOENT before a
 * single test registers, which reads as a missing bundle rather than as a wrong cwd. Resolving
 * from `import.meta.url` also follows a hoisted or nested install instead of assuming the flat
 * one. `join` rather than string concatenation, so the separator is the platform's.
 *
 * monaco-editor's `exports` map has no `./package.json` entry, so this leans on bun's resolver
 * answering it anyway (verified: it returns the installed package's own manifest). If that ever
 * stops being true the failure is a named resolution error here, not a silent wrong path.
 */
const MONACO_ROOT = dirname(createRequire(import.meta.url).resolve("monaco-editor/package.json"));
const BASIC_CONTRIBUTION = join(MONACO_ROOT, "min/vs/basic-languages/monaco.contribution.js");
const RICH_LANGUAGE_DIR = join(MONACO_ROOT, "min/vs/language");

/**
 * The version the two counts below are counts OF.
 *
 * A bare 89 in an assertion is a digit with no basis, and the repair when it moves is to
 * re-measure rather than to edit the digit. Read from the installed package so a dependency bump
 * fails here first, with the old and the new version both on screen.
 */
const MONACO_VERSION = "0.56.0";
const BASIC_LANGUAGE_COUNT = 89;

/**
 * Pulls every language id out of the minified basic-languages contribution.
 *
 * Each language is registered by one call taking an object literal whose first key is `id`,
 * followed by one of the descriptor keys. The trailing key is part of the pattern deliberately:
 * matching a bare `{id:"..."` would also catch unrelated object literals in the same bundle, and
 * the count assertion is what tells us this pattern found the registrations rather than something
 * that merely looks like them.
 */
function extractBasicLanguageIds(source: string): ReadonlySet<string> {
  const ids = new Set<string>();
  const pattern = /\{id:"([A-Za-z0-9_.+-]+)",(?:extensions|aliases|firstLine|mimetypes|loader):/g;
  for (const match of source.matchAll(pattern)) {
    const [, id] = match;
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

const basic = extractBasicLanguageIds(readFileSync(BASIC_CONTRIBUTION, "utf8"));
const rich: readonly string[] = readdirSync(RICH_LANGUAGE_DIR).sort();

/** The unconnected connection shape the census uses, for the same reason: nothing here dials. */
const unconnected = (type: DatabaseType): DatabaseConnection =>
  ({
    id: "language-guard",
    name: "language-guard",
    type,
    host: "127.0.0.1",
    port: 1,
    database: "language_guard",
    user: "language_guard",
    password: "language_guard",
    filePath: ":memory:",
    url: "http://127.0.0.1:1",
    connectionString: "mongodb://127.0.0.1:1/language_guard",
    localDataCenter: "datacenter1",
    createdAt: new Date(0),
  }) as DatabaseConnection;

/**
 * The flavour a MariaDB server is measured as, which is the derived fact the provider stores
 * once it has read `SELECT VERSION()`.
 *
 * SECOND OWNER, DISCLOSED RATHER THAN HOISTED. `tests/isolated/object-source-declarations.test.ts`
 * carries the same constant and the same private-field write, because the census needs the MariaDB
 * branch for the same structural reason this file does. Standing ruling 5h says to report a helper
 * about to be written again rather than hoist it while another implementer holds the checkout, and
 * a shared module for it would be a third file this task does not own, so the two copies stay and
 * this note is the pointer between them.
 *
 * The duplication cannot drift in SILENCE, which is the part that matters and which was measured
 * in fix round 1: a flavour the provider no longer knows is a type error at the write, and a write
 * that lands on nothing leaves the MySQL default answering. Here that is `toContain("mysql/package")`
 * in the membership test; in the census it is the named throw plus the MariaDB triple set. So a
 * rename applied in one file only fails the other rather than quietly censusing six kinds.
 */
const MARIADB_FLAVOUR = "mariadb";

/**
 * The mysql provider with a MariaDB server's flavour already measured onto it.
 *
 * Isolated here rather than written inline inside the fleet loop, so this file holds ONE place
 * that knows about MariaDB instead of a type-id branch in the middle of a population walk. The
 * private `measuredFlavour` is written directly rather than stubbing `getCapabilities`,
 * because a stub would answer a kind list this test typed and the point of the guard is that the
 * code produces it. If the field is ever renamed the write lands on nothing, the MySQL six answer,
 * and the membership test's `mysql/package` control fails by name.
 */
const MARIADB_CAPABLE_TYPE: DatabaseType = "mysql";

const withMeasuredMariaDBFlavour = <T>(provider: T): T => {
  (provider as unknown as { measuredFlavour: "mysql" | "mariadb" }).measuredFlavour = MARIADB_FLAVOUR;
  return provider;
};

/**
 * Every `sourceLanguage` any provider in the fleet declares, with the kind it came from.
 *
 * The MariaDB branch is included, because `createDatabaseProvider("mysql")` is unconnected and
 * `objectKindsFor(undefined)` answers the MySQL six: MariaDB's `package` and `sequence` would
 * otherwise never be language-checked at all. `withMeasuredMariaDBFlavour` above is the only place
 * in this file that knows which type-id that is.
 */
async function everyDeclaredSourceLanguage(): Promise<
  readonly { readonly where: string; readonly language: string }[]
> {
  const found: { readonly where: string; readonly language: string }[] = [];
  for (const type of [...EXTERNAL_DATABASE_TYPES, "libredb"] as readonly DatabaseType[]) {
    const built = await createDatabaseProvider(unconnected(type));
    const provider = type === MARIADB_CAPABLE_TYPE ? withMeasuredMariaDBFlavour(built) : built;
    for (const kind of declaredKinds(provider.getCapabilities())) {
      if (kind.sourceLanguage !== undefined) found.push({ where: `${type}/${kind.id}`, language: kind.sourceLanguage });
    }
  }
  return found;
}

describe("the installed editor's language ids", () => {
  test("the extraction found the bundle, so every membership assertion below is not vacuous", () => {
    const installed: string = JSON.parse(readFileSync(`${MONACO_ROOT}/package.json`, "utf8")).version;
    expect(installed).toBe(MONACO_VERSION);
    expect(basic.size).toBe(BASIC_LANGUAGE_COUNT);
    // Positive controls first. A broken pattern makes the size wrong, and these say the ids it did
    // find are language ids rather than whatever else the minified bundle holds.
    for (const id of ["sql", "pgsql", "mysql", "lua", "redis"]) expect([...basic]).toContain(id);

    // The negative half, which is only meaningful next to the positives above: these three are the
    // dialects the fleet WOULD declare if the editor knew them, and the reason Oracle, SQL Server
    // and Cassandra all render under `sql` instead. If a monaco bump ever adds one, this fails and
    // the repair is to reconsider those three declarations, not to delete the line.
    for (const id of ["plsql", "tsql", "cql"]) expect([...basic]).not.toContain(id);

    // The rich languages, read from their own directory rather than assumed into the set above.
    // `json` lives here, and it is the declared language of five source-bearing kinds.
    expect(rich).toEqual(["css", "html", "json", "typescript"]);
    // Each of the four rich ids pinned INDIVIDUALLY against the basic set, which is the assertion
    // that would have caught the false sentence this docblock used to carry. Three of the four are
    // registered by the basic contribution as well; `json` is the one that is not, and that single
    // absence is why the rich half of `registered` below is load-bearing at all. A monaco bump that
    // adds a basic `json`, or that drops one of the other three, fails here by id.
    expect({
      css: basic.has("css"),
      html: basic.has("html"),
      json: basic.has("json"),
      typescript: basic.has("typescript"),
    }).toEqual({ css: true, html: true, json: false, typescript: true });
  });

  test("a language id this repository registers itself is not one the installed editor registers (#1085)", () => {
    // `registerPromqlLanguage` returns early when its id is already registered, and the basic
    // contribution registers every id it ships at load time, before any `beforeMount` runs. An id
    // the bundle already had would leave Monaco's own tokenizer in charge, or none, and nothing on
    // screen would say so. The control is an id the bundle does ship, read through the same set.
    expect(basic.has(PROMQL_LANGUAGE_ID)).toBe(false);
    expect(rich).not.toContain(PROMQL_LANGUAGE_ID);
    expect(basic.has("redis")).toBe(true);
  });

  test("every declared sourceLanguage is an id the installed editor registers", async () => {
    const registered = new Set([...basic, ...rich]);
    const declared = await everyDeclaredSourceLanguage();

    // The zero-iteration case of the loop below certifies NOTHING about the fleet, and a provider
    // set that failed to build would produce exactly that, so it is refused by name.
    if (declared.length === 0) {
      throw new Error("the language guard inspected 0 declared languages, so it certifies nothing about the fleet");
    }
    // MariaDB's two kinds are inside the population, which no unconnected read would show. This
    // and the throw above are what make the membership assertion below non-vacuous, so both come
    // first.
    expect(declared.map((entry) => entry.where)).toContain("mysql/package");
    expect(declared.map((entry) => entry.where)).toContain("mysql/sequence");
    expect(declared).toHaveLength(60);

    const unregistered = declared.filter((entry) => !registered.has(entry.language));
    // Named, so a failure says which kind on which engine declared what, rather than false. This
    // is the assertion the whole file exists for, and it is asserted BEFORE the content control
    // below on purpose: MEASURED, with the control first, declaring `plsql` on Oracle died on the
    // control instead and the membership check never ran, which would have read as a kill of a
    // guard that had not executed.
    expect(unregistered.map((entry) => `${entry.where}: ${entry.language}`)).toEqual([]);

    // Non-vacuous in CONTENT and not only in count: these are the five distinct languages the
    // fleet declares, so a population that reached only the SQL engines fails here rather than
    // passing a membership loop that never saw `json` or `lua`.
    expect([...new Set(declared.map((entry) => entry.language))].sort()).toEqual([
      "json",
      "lua",
      "mysql",
      "pgsql",
      "sql",
    ]);
  });
});
