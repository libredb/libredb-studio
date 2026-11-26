/**
 * The value import walk of tests/helpers/value-import-closure.ts over a module that imports a JSON file: the legacy
 * adapter's identity (src/lib/provider-host/legacy-adapter/identity.ts) imports the root package.json for its version,
 * and every closure test whose start reaches the server's engine catalog walks through it.
 */
import { describe, expect, test } from "bun:test";
import { valueImportClosure } from "../../helpers/value-import-closure";

describe("valueImportClosure", () => {
  test("a JSON module is a leaf of the closure, listed and never scanned", () => {
    const closure = valueImportClosure("src/lib/provider-host/legacy-adapter/identity.ts");
    expect(closure.modules).toContain("package.json");
    expect(closure.unresolved).toEqual([]);
    // Nothing the root package.json names is followed: its dependencies are no import of the walk.
    expect(closure.packages).not.toContain("next");
  });
});
