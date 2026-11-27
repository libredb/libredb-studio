/**
 * The grammar digest (src/lib/db/grammar-digest.ts) and the language data digest (src/lib/db/language-digest.ts) hash
 * with node:crypto, so both are server-only modules: the server catalog's composer
 * (src/lib/db/server-catalog-compose.ts) is the one module of Studio's source that imports each digest, and the grant
 * reader (src/lib/db/claim-grants.ts), which the
 * browser loads, reaches neither. The canonical text both digests read (src/lib/db/canonical-json.ts) reaches no
 * node:crypto, so a module the browser loads may read it.
 *
 * Every `.ts` and `.tsx` module under src is read with tests/helpers/value-import-closure.ts, so a type-only import is
 * left out and a re-export is counted: a module that re-exports a digest is itself an importer, and fails the first
 * two tests before any module can import the digest through it. Tests import the digests freely and are not read.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { valueImportClosure, valueImportsOf } from "../../helpers/value-import-closure";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const DIGEST = "src/lib/db/grammar-digest.ts";
const LANGUAGE_DIGEST = "src/lib/db/language-digest.ts";
const CANONICAL_TEXT = "src/lib/db/canonical-json.ts";
const COMPOSER = "src/lib/db/server-catalog-compose.ts";
const GRANT_READER = "src/lib/db/claim-grants.ts";

/** Every `.ts` and `.tsx` module under src, repository-relative with forward slashes on every platform. */
function sourceModules(): string[] {
  return readdirSync(join(REPO_ROOT, "src"), { recursive: true, encoding: "utf8" })
    .map((file) => `src/${file.split("\\").join("/")}`)
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".d.ts"))
    .sort();
}

describe("the grammar digest stays on the server", () => {
  test("the server catalog's composer is the one module of src that imports the digest, directly or by a re-export", () => {
    expect(sourceModules().filter((module) => valueImportsOf(module).includes(DIGEST))).toEqual([COMPOSER]);
  });

  test("the server catalog's composer is the one module of src that imports the language digest, directly or by a re-export", () => {
    expect(sourceModules().filter((module) => valueImportsOf(module).includes(LANGUAGE_DIGEST))).toEqual([COMPOSER]);
  });

  test("the grant reader the browser loads reaches neither digest nor node:crypto", () => {
    const closure = valueImportClosure(GRANT_READER);
    expect(closure.unresolved).toEqual([]);
    expect(closure.modules).not.toContain(DIGEST);
    expect(closure.modules).not.toContain(LANGUAGE_DIGEST);
    expect(closure.packages).not.toContain("node:crypto");
  });

  test("the canonical text module reaches no node:crypto", () => {
    const closure = valueImportClosure(CANONICAL_TEXT);
    expect(closure.unresolved).toEqual([]);
    expect(closure.packages).not.toContain("node:crypto");
  });

  test("the walk sees the digest and node:crypto where they are reached, the control", () => {
    const composer = valueImportClosure(COMPOSER);
    expect(composer.modules).toContain(DIGEST);
    expect(composer.modules).toContain(LANGUAGE_DIGEST);
    expect(composer.modules).toContain(CANONICAL_TEXT);
    expect(composer.packages).toContain("node:crypto");
    const language = valueImportClosure(LANGUAGE_DIGEST);
    expect(language.modules).toContain(CANONICAL_TEXT);
    expect(language.packages).toContain("node:crypto");
    expect(sourceModules()).toContain(GRANT_READER);
    expect(sourceModules()).toContain(LANGUAGE_DIGEST);
  });
});
