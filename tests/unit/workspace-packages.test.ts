/**
 * The workspace package listing every gate reads (packages/README.md, "Layout").
 *
 * A package is a directory `packages/<name>/` holding a `package.json`. Anything else
 * that is a directory under `packages/` is refused by name, because a gate that skipped
 * it would leave its tests unrun and its source unmeasured without a word.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isPackageSourcePath,
  isPackageTestPath,
  workspacePackageDirectories,
} from "../../scripts/workspace-packages.mjs";

const repositoryRoot = path.resolve(import.meta.dir, "../..");
const scratchRoots: string[] = [];

/** A throwaway root holding the given files, each written empty unless content is given. */
function root(files: Record<string, string> = {}): string {
  const scratch = mkdtempSync(path.join(tmpdir(), "workspace-packages-"));
  scratchRoots.push(scratch);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
    writeFileSync(path.join(scratch, file), content);
  }
  return scratch;
}

afterEach(() => {
  for (const scratch of scratchRoots.splice(0)) rmSync(scratch, { recursive: true, force: true });
});

describe("workspacePackageDirectories", () => {
  test("returns no package when packages/ is absent", () => {
    expect(workspacePackageDirectories(root({ "package.json": "{}" }))).toEqual([]);
  });

  test("skips files such as packages/README.md", () => {
    expect(workspacePackageDirectories(root({ "packages/README.md": "# Packages\n" }))).toEqual([]);
  });

  test("lists each directory holding a package.json, sorted, as packages/<name>", () => {
    const scratch = root({
      "packages/zeta/package.json": "{}",
      "packages/alpha/package.json": "{}",
      "packages/README.md": "",
    });

    expect(workspacePackageDirectories(scratch)).toEqual(["packages/alpha", "packages/zeta"]);
  });

  test("refuses a directory under packages/ without a package.json by name", () => {
    const scratch = root({ "packages/planted/package.json": "{}", "packages/stray/tests/a.test.ts": "" });

    expect(() => workspacePackageDirectories(scratch)).toThrow(
      "packages/stray has no package.json, so it is not a workspace package",
    );
  });

  test("refuses a symbolic link under packages/ by name", () => {
    const scratch = root({ "elsewhere/package.json": "{}" });
    mkdirSync(path.join(scratch, "packages"));
    // A junction needs no privilege on Windows; on POSIX the type argument is ignored.
    symlinkSync(path.join(scratch, "elsewhere"), path.join(scratch, "packages/linked"), "junction");

    expect(() => workspacePackageDirectories(scratch)).toThrow("packages/linked is a symbolic link or junction");
  });

  test("the repository lists no package today", () => {
    expect(workspacePackageDirectories(repositoryRoot)).toEqual([]);
  });
});

describe("the package path rules", () => {
  test("a package's source is what sits under packages/<name>/src/", () => {
    expect(isPackageSourcePath("packages/planted/src/index.ts")).toBe(true);
    expect(isPackageSourcePath("packages/planted/src/deep/a.ts")).toBe(true);
    expect(isPackageSourcePath("packages/planted/tests/a.test.ts")).toBe(false);
    expect(isPackageSourcePath("packages/src/index.ts")).toBe(false);
    expect(isPackageSourcePath("src/lib/types.ts")).toBe(false);
  });

  test("a package's tests are what sits under packages/<name>/tests/", () => {
    expect(isPackageTestPath("packages/planted/tests/a.test.ts")).toBe(true);
    expect(isPackageTestPath("packages/planted/src/a.test.ts")).toBe(false);
    expect(isPackageTestPath("packages/tests/a.test.ts")).toBe(false);
    expect(isPackageTestPath("tests/unit/a.test.ts")).toBe(false);
  });
});
