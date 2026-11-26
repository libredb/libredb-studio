/**
 * The grammar digest (src/lib/db/grammar-digest.ts) hashes with node:crypto, so it is a server-only module: the server
 * catalog's composer (src/lib/db/server-catalog-compose.ts) is the one module of Studio's source that imports it, and
 * the grant reader (src/lib/db/claim-grants.ts), which the browser loads, never reaches it.
 *
 * Every `.ts` and `.tsx` module under src is read with tests/helpers/value-import-closure.ts, so a type-only import is
 * left out and a re-export is counted: a module that re-exports the digest is itself an importer, and fails the first
 * test before any module can import the digest through it. Tests import the digest freely and are not read.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { valueImportClosure, valueImportsOf } from "../../helpers/value-import-closure";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const DIGEST = "src/lib/db/grammar-digest.ts";
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

  test("the grant reader the browser loads reaches neither the digest nor node:crypto", () => {
    const closure = valueImportClosure(GRANT_READER);
    expect(closure.unresolved).toEqual([]);
    expect(closure.modules).not.toContain(DIGEST);
    expect(closure.packages).not.toContain("node:crypto");
  });

  test("the walk sees the digest and node:crypto where they are reached, the control", () => {
    const closure = valueImportClosure(COMPOSER);
    expect(closure.modules).toContain(DIGEST);
    expect(closure.packages).toContain("node:crypto");
    expect(sourceModules()).toContain(GRANT_READER);
  });
});
