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
 * - The four RICH languages (`css`, `html`, `json`, `typescript`) are NOT among those 89. They are
 *   separate worker-backed modules under `vs/language/`. `json` is the declared language of five
 *   source-bearing kinds across the two search products and MongoDB, so a guard that extracted the
 *   89 and then asserted `json` was among them would be asserting a value the test itself wrote,
 *   and it would fail for a reason that has nothing to do with any declaration.
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
 * Measured on monaco-editor 0.56.0, 2026-09-13: 89 basic ids, 4 rich ids.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { declaredKinds } from "@/lib/db/object-kinds";
import type { DatabaseConnection } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";

const MONACO_ROOT = "node_modules/monaco-editor";
const BASIC_CONTRIBUTION = `${MONACO_ROOT}/min/vs/basic-languages/monaco.contribution.js`;
const RICH_LANGUAGE_DIR = `${MONACO_ROOT}/min/vs/language`;

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
export function extractBasicLanguageIds(source: string): ReadonlySet<string> {
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

/** MariaDB's own `VERSION()` string, measured on `mariadb:latest` 12.3.2 by the mysql task. */
const MARIADB_VERSION_STRING = "12.3.2-MariaDB-ubu2404";

/**
 * Every `sourceLanguage` any provider in the fleet declares, with the kind it came from.
 *
 * The MariaDB branch is included, because `createDatabaseProvider("mysql")` is unconnected and
 * `objectKindsFor(undefined)` answers the MySQL six: MariaDB's `package` and `sequence` would
 * otherwise never be language-checked at all. The private measured version is written directly so
 * the real `objectKindsFor` runs; a stub of `getCapabilities` would return a list this test typed.
 */
async function everyDeclaredSourceLanguage(): Promise<
  readonly { readonly where: string; readonly language: string }[]
> {
  const found: { readonly where: string; readonly language: string }[] = [];
  for (const type of [...EXTERNAL_DATABASE_TYPES, "libredb"] as readonly DatabaseType[]) {
    const provider = await createDatabaseProvider(unconnected(type));
    if (type === "mysql") {
      (provider as unknown as { measuredServerVersion: string | undefined }).measuredServerVersion =
        MARIADB_VERSION_STRING;
    }
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
    expect(basic.has("json")).toBe(false);
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
