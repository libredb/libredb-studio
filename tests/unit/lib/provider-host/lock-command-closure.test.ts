/**
 * The value-import closures of the lock command (scripts/providers-lock.ts) and the key command
 * (scripts/providers-key.ts). The lock command ships to operators, so it reaches none of Studio's engine knowledge: no
 * module of the engine catalog or the engine declarations, no compatibility table, no type-id module, no logger, and no
 * package but acorn and Node.js built-ins, so not the SDK's manifest validator either. The key command is a repository
 * command that validates a manifest with the SDK, so the SDK is its own; it reaches no engine catalog, type-id or logger
 * module either.
 *
 * Each test carries its controls: the same judge names the forbidden modules in the closure of a real module that
 * imports them, so a judge that names nothing fails.
 */
import { describe, expect, test } from "bun:test";
import { type ValueImportClosure, valueImportClosure } from "../../../helpers/value-import-closure";

/** The modules no closure of the two commands may reach, by path or path prefix. */
const FORBIDDEN_MODULES: readonly string[] = [
  "src/lib/db/engine-catalog/",
  "src/lib/db/engine-declarations/",
  "src/lib/db/compatibility.ts",
  "src/lib/db/type-id.ts",
  "src/lib/logger.ts",
];

/** The forbidden modules `closure` reaches. */
function forbiddenModules(closure: ValueImportClosure): string[] {
  return closure.modules.filter((module) =>
    FORBIDDEN_MODULES.some((forbidden) =>
      forbidden.endsWith("/") ? module.startsWith(forbidden) : module === forbidden,
    ),
  );
}

/** The packages of `closure` the lock command may not import: anything but acorn and a `node:` built-in. */
function forbiddenPackages(closure: ValueImportClosure): string[] {
  return closure.packages.filter((name) => name !== "acorn" && !name.startsWith("node:"));
}

describe("the lock commands' closures", () => {
  test("the lock command reaches no engine catalog module, no type-id module, no logger and no manifest validator", () => {
    const closure = valueImportClosure("scripts/providers-lock.ts");
    expect(closure.unresolved).toEqual([]);
    expect(forbiddenModules(closure)).toEqual([]);
    expect(forbiddenPackages(closure)).toEqual([]);
    expect(closure.packages).toEqual(["acorn", "node:crypto", "node:fs", "node:path"]);

    // Controls: type-id.ts imports the engine catalog, and the providers directory module imports the logger.
    const typeId = forbiddenModules(valueImportClosure("src/lib/db/type-id.ts"));
    expect(typeId).toContain("src/lib/db/type-id.ts");
    expect(typeId).toContain("src/lib/db/compatibility.ts");
    expect(typeId.some((module) => module.startsWith("src/lib/db/engine-catalog/"))).toBe(true);
    expect(forbiddenModules(valueImportClosure("src/lib/provider-host/providers-dir.ts"))).toContain(
      "src/lib/logger.ts",
    );
  });

  test("the key command reaches no engine catalog module, no type-id module and no logger", () => {
    const closure = valueImportClosure("scripts/providers-key.ts");
    expect(closure.unresolved).toEqual([]);
    expect(closure.modules).toContain("scripts/providers-lock.ts");
    expect(forbiddenModules(closure)).toEqual([]);

    // Control: the key command validates a manifest with the SDK, a package the lock command's rule refuses.
    expect(forbiddenPackages(closure)).toContain("@libredb/provider-sdk/manifest");
  });
});
