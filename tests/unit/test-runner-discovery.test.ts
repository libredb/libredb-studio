import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testIf } from "../helpers/posix-tools";
import { COVERAGE_EXEMPT_FILES, discoverTestFiles, selectTestFiles } from "../runner/discover";

// The guard that replaces tests/unit/component-runner-coverage.test.ts: that file
// existed because tests/run-components.sh named its files by hand, so a new file
// could be added and never run (#426 shipped seven tests that never ran once).
// Discovery is now automatic, so the invariant worth pinning is the other way
// round: the rule the runner applies must equal what is on disk, and no directory
// may quietly fall outside it.
const root = path.resolve(import.meta.dir, "../..");

// The oracle classifies with lstat, not with the Dirent: a Dirent for a link is
// neither a directory nor a file, so an oracle built on it would share the blind
// spot this test exists to catch, and agree with a runner that skipped a link.
function walk(directory: string): string[] {
  return readdirSync(path.join(root, directory)).flatMap((name) => {
    const child = `${directory}/${name}`;
    const stats = lstatSync(path.join(root, child));
    if (stats.isSymbolicLink()) throw new Error(`${child} is a link, which the runner refuses`);
    if (stats.isDirectory()) return walk(child);
    return stats.isFile() && /\.test\.tsx?$/.test(name) ? [child] : [];
  });
}

/** A throwaway repository root holding only `tests/unit/real.test.ts`; the caller removes it. */
function throwawayRoot(): string {
  const scratch = mkdtempSync(path.join(tmpdir(), "runner-links-"));
  mkdirSync(path.join(scratch, "tests/unit"), { recursive: true });
  writeFileSync(path.join(scratch, "tests/unit/real.test.ts"), "");
  return scratch;
}

// A file symlink on Windows needs SeCreateSymbolicLinkPrivilege or Developer Mode,
// which a runner cannot count on; a directory junction needs neither, so the
// junction case carries the Windows measurement and only the file case is skipped.
const MISSING_FILE_SYMLINKS: string | null =
  process.platform === "win32" ? "file symlinks need a privilege or Developer Mode on Windows" : null;

describe("test discovery", () => {
  test("runs every *.test.ts(x) file under tests/, except tests/live", () => {
    const onDisk = walk("tests")
      .filter((file) => !file.startsWith("tests/live/"))
      .sort();

    expect(discoverTestFiles(root)).toEqual(onDisk);
  });

  test("discovers the layers the suite is made of, and each one is non-empty", () => {
    const files = discoverTestFiles(root);
    const layers = ["unit", "api", "integration", "hooks", "security", "evals", "components", "isolated"];

    for (const layer of layers) {
      expect(files.filter((file) => file.startsWith(`tests/${layer}/`)).length).toBeGreaterThan(0);
    }
    // Nothing outside those layers: a new top-level directory has to be added to
    // the list above deliberately, which is where someone reads this test.
    const outside = files.filter((file) => !layers.some((layer) => file.startsWith(`tests/${layer}/`)));
    expect(outside).toEqual([]);
  });

  test("excludes tests/live, which drives real engines and is run by hand", () => {
    expect(discoverTestFiles(root).some((file) => file.startsWith("tests/live/"))).toBe(false);
  });

  test("returns POSIX-separated paths, sorted, with no duplicates", () => {
    const files = discoverTestFiles(root);

    expect(files.some((file) => file.includes("\\"))).toBe(false);
    expect([...files].sort()).toEqual(files);
    expect(new Set(files).size).toBe(files.length);
  });

  test("a selector may be a layer directory", () => {
    const selected = selectTestFiles(root, ["tests/unit"]);

    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every((file) => file.startsWith("tests/unit/"))).toBe(true);
    expect(selected).toEqual(discoverTestFiles(root).filter((file) => file.startsWith("tests/unit/")));
  });

  test("a selector may be a single test file, spelled with either separator", () => {
    const one = "tests/unit/test-runner-discovery.test.ts";

    expect(selectTestFiles(root, [one])).toEqual([one]);
    expect(selectTestFiles(root, [one.replaceAll("/", path.sep)])).toEqual([one]);
    expect(selectTestFiles(root, [path.join(root, one)])).toEqual([one]);
  });

  test("a relative selector means what it means in the directory it was typed in", () => {
    // From tests/unit, `bun ../run-tests.ts lib/lazy.test.ts` names the file beside
    // you. Resolving against the repository root instead answered "is not under
    // tests/", a true sentence about a path nobody wrote.
    const cwd = process.cwd();
    try {
      process.chdir(path.join(root, "tests/unit"));
      expect(selectTestFiles(root, ["lib/lazy.test.ts"])).toEqual(["tests/unit/lib/lazy.test.ts"]);
    } finally {
      process.chdir(cwd);
    }
  });

  test("a root spelled differently from the working directory is still the same directory", () => {
    // Measured on windows-latest, 2026-09-15: os.tmpdir() answers the 8.3 short form
    // (C:\Users\RUNNER~1\...) while import.meta.dir answers the long one
    // (C:\Users\runneradmin\...), so a runner started from a temp directory resolved a
    // correct relative selector to a path "not under tests/" and exited 2. A junction
    // reproduces the same two spellings of one directory on every platform (on POSIX
    // the type argument is ignored and it is an ordinary directory symlink).
    const link = path.join(mkdtempSync(path.join(tmpdir(), "runner-spelling-")), "repo");
    symlinkSync(root, link, "junction");
    try {
      expect(selectTestFiles(link, ["tests/unit/lib/lazy.test.ts"])).toEqual(["tests/unit/lib/lazy.test.ts"]);
    } finally {
      rmSync(path.dirname(link), { recursive: true, force: true });
    }
  });

  test("a relative selector that passes through a link names the file behind the link", () => {
    // `u/x.test.ts`, typed where u is a link to tests/unit, is tests/unit/x.test.ts, as
    // the same path given absolutely already was. Only the working directory used to
    // be resolved, so the link's own spelling reached path.relative and the selector
    // was "not under tests/". A junction needs no privilege on Windows; on POSIX the
    // type argument is ignored and it is an ordinary directory symlink.
    const unitFiles = discoverTestFiles(root).filter((file) => file.startsWith("tests/unit/"));
    const one = unitFiles[0];
    if (one === undefined) throw new Error("tests/unit holds no test file to select through a link");
    const scratch = mkdtempSync(path.join(tmpdir(), "runner-selector-link-"));
    symlinkSync(path.join(root, "tests/unit"), path.join(scratch, "u"), "junction");
    symlinkSync(path.join(root, "src"), path.join(scratch, "s"), "junction");
    const cwd = process.cwd();
    try {
      process.chdir(scratch);
      expect(selectTestFiles(root, [`u/${one.slice("tests/unit/".length)}`])).toEqual([one]);
      expect(selectTestFiles(root, ["u"])).toEqual(unitFiles);
      // A link that leads outside tests/ is still outside tests/.
      expect(() => selectTestFiles(root, ["s"])).toThrow(/"s" is not under tests\//);
    } finally {
      process.chdir(cwd);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("a directory link under tests/ is refused by name, never silently skipped", () => {
    const repository = throwawayRoot();
    const elsewhere = mkdtempSync(path.join(tmpdir(), "runner-links-target-"));
    try {
      writeFileSync(path.join(elsewhere, "other.test.ts"), "");
      // The control: the same root without the link is discovered normally.
      expect(discoverTestFiles(repository)).toEqual(["tests/unit/real.test.ts"]);

      symlinkSync(elsewhere, path.join(repository, "tests/unit/linked"), "junction");
      expect(() => discoverTestFiles(repository)).toThrow(/tests\/unit\/linked .*does not follow links/);
      expect(() => selectTestFiles(repository, ["tests/unit/real.test.ts"])).toThrow(/tests\/unit\/linked/);
    } finally {
      rmSync(repository, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  testIf(MISSING_FILE_SYMLINKS, "a file link under tests/ is refused by name, never silently skipped", () => {
    const repository = throwawayRoot();
    const elsewhere = mkdtempSync(path.join(tmpdir(), "runner-links-target-"));
    try {
      writeFileSync(path.join(elsewhere, "target.test.ts"), "");
      // The control: the same root without the link is discovered normally.
      expect(discoverTestFiles(repository)).toEqual(["tests/unit/real.test.ts"]);

      symlinkSync(path.join(elsewhere, "target.test.ts"), path.join(repository, "tests/unit/file.test.ts"), "file");
      expect(() => discoverTestFiles(repository)).toThrow(/tests\/unit\/file\.test\.ts .*does not follow links/);
    } finally {
      rmSync(repository, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("selecting nothing selects everything", () => {
    expect(selectTestFiles(root, [])).toEqual(discoverTestFiles(root));
  });

  test("a selector that matches no test file is an error, never a quiet empty run", () => {
    expect(() => selectTestFiles(root, ["tests/unit/there-is-no-such.test.ts"])).toThrow(
      /tests\/unit\/there-is-no-such\.test\.ts/,
    );
    expect(() => selectTestFiles(root, ["tests/live"])).toThrow(/no test files/);
    expect(() => selectTestFiles(root, ["src/lib"])).toThrow(/tests\//);
  });

  test("a relative selector that does not exist is refused for what it is, not for where it is", () => {
    // The relative resolution has to hold for a path that is not on disk too, or the
    // runner answers the wrong question: resolved against the repository root instead,
    // `no-such.test.ts` typed in tests/unit becomes <root>/no-such.test.ts and is
    // refused as "not under tests/", which is a true sentence about a path nobody wrote
    // and sends the reader looking for a directory problem instead of a typo.
    const cwd = process.cwd();
    try {
      process.chdir(path.join(root, "tests/unit"));
      expect(() => selectTestFiles(root, ["no-such.test.ts"])).toThrow(/matched no test files/);
      // The control: the same working directory, a selector that is really outside tests/.
      expect(() => selectTestFiles(root, ["../../src/lib"])).toThrow(/is not under tests\//);
    } finally {
      process.chdir(cwd);
    }
  });

  test("every coverage-exempt file exists and is discovered", () => {
    const files = new Set(discoverTestFiles(root));

    expect(COVERAGE_EXEMPT_FILES.length).toBeGreaterThan(0);
    for (const file of COVERAGE_EXEMPT_FILES) {
      expect(files.has(file)).toBe(true);
    }
  });
});
