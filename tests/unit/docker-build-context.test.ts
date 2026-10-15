/**
 * Every file `next build` type-checks inside the Docker build context must find its imports there.
 *
 * `next build` type-checks every file that tsconfig.json includes and the context still holds, while `.dockerignore`
 * drops the test trees and other paths. A kept file that imports a dropped one fails the image build with TS2307,
 * although the CI typecheck passes on the full checkout. docker-context-test-imports.test.ts guards the repository
 * root only; this walks the whole context, which is how `scripts/generate-governance-vectors.ts` importing the test
 * sealer under `tests/` broke the image unnoticed.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import nodePath, { join, posix, win32 } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

const patterns = readFileSync(join(ROOT, ".dockerignore"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

function matches(pattern: string, path: string): boolean {
  const glob = new Bun.Glob(pattern);
  const segments = path.split("/");
  return segments.some((_, index) => glob.match(segments.slice(0, index + 1).join("/")));
}

/** Docker's rule: the last pattern that matches a path or one of its parent directories decides. */
function ignored(path: string): boolean {
  let result = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    if (matches(negated ? pattern.slice(1) : pattern, path)) result = !negated;
  }
  return result;
}

const tsconfig = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")) as {
  include: string[];
  exclude: string[];
};
const includes = tsconfig.include.map((pattern) => new Bun.Glob(pattern));
const excludes = tsconfig.exclude.map((pattern) => new Bun.Glob(pattern));

/**
 * The path of `file` relative to `root` with "/" on every platform, as .dockerignore, tsconfig.json and the cases below
 * spell paths: `path.relative` joins with "\" on Windows, which `ignored` does not split on and no "/" literal equals.
 */
function contextPath(root: string, file: string, paths: typeof posix = nodePath): string {
  return paths.relative(root, file).split(paths.sep).join("/");
}

/** The files of the Docker build context that tsconfig.json includes, so the ones `next build` type-checks. */
function typeCheckedContextFiles(dir = ROOT, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = contextPath(ROOT, join(dir, entry.name));
    if (entry.name === ".git" || ignored(path) || excludes.some((glob) => glob.match(path))) continue;
    if (entry.isDirectory()) typeCheckedContextFiles(join(dir, entry.name), found);
    else if (includes.some((glob) => glob.match(path))) found.push(path);
  }
  return found;
}

const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".d.ts", ".js", ".mjs", ".json", "/index.ts", "/index.tsx"];

/**
 * The repository path an import specifier names, or undefined for a package import. `file` and the specifier both
 * use "/", so the target is resolved with `path.posix` and keeps "/" on every platform.
 */
function importTarget(file: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith("@/")) base = posix.join("src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = posix.join(file, "..", specifier);
  else return undefined;
  const existing = EXTENSIONS.map((extension) => base + extension).find((candidate) => {
    const path = join(ROOT, candidate);
    return existsSync(path) && statSync(path).isFile();
  });
  return existing ?? base;
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

describe(".dockerignore keeps every file next build type-checks resolvable", () => {
  test("the walk sees the application, its scripts and its root configs", () => {
    const files = typeCheckedContextFiles();
    expect(files).toContain("src/proxy.ts");
    expect(files).toContain("next.config.ts");
    expect(files).toContain("scripts/generate-governance-manifest.ts");
    expect(files.some((file) => file.startsWith("tests/"))).toBe(false);
  });

  test("a path the walk takes on Windows compares as the / path the patterns and these cases spell", () => {
    const root = "D:\\a\\libredb-studio\\libredb-studio";
    const onWindows = (...segments: string[]) => contextPath(root, win32.join(root, ...segments), win32);
    expect(onWindows("src", "proxy.ts")).toBe("src/proxy.ts");
    expect(onWindows("src", "app", "admin", "audit", "page.tsx")).toBe("src/app/admin/audit/page.tsx");
    expect(ignored(onWindows("tests", "helpers", "governance", "lsb1-seal.ts"))).toBe(true);
  });

  test("a file the context drops is reported through its parent directory or its own pattern", () => {
    expect(ignored("tests/helpers/governance/lsb1-seal.ts")).toBe(true);
    expect(ignored("src/lib/governance/hpke.ts")).toBe(false);
    expect(ignored("README.md")).toBe(false);
    expect(ignored("docs/GOVERNANCE.md")).toBe(true);
  });

  test("no file that next build type-checks imports a path that .dockerignore excludes", () => {
    const offenders: string[] = [];
    for (const file of typeCheckedContextFiles()) {
      for (const specifier of importSpecifiers(readFileSync(join(ROOT, file), "utf8"))) {
        const target = importTarget(file, specifier);
        if (target !== undefined && ignored(target)) offenders.push(`${file} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
