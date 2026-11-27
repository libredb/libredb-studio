/**
 * The packed lock command check (`bun run lib:lock`, scripts/check-lib-lock.ts; docs/TOOLCHAIN.md, "The lock command
 * module (`lib:lock`)"): the packed npm package's `providers lock` writes, with no checkout of Studio and no download,
 * a lock Studio's reader admits, byte for byte the lock `bun run providers:lock` writes.
 *
 * The cases pack a planted package root: the repository's bin/ copied, and a dist/providers-lock.mjs built by the build
 * function `build:lib` runs, or a planted stub. Packing extracts with tar, so those cases need one (Windows 11 ships
 * bsdtar as System32\tar.exe). Every spawn is synchronous and bounded by a timeout.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { buildLockModule } from "../../scripts/build-lock-module.mjs";
import { checkLibLock } from "../../scripts/check-lib-lock";
import { describeIf, missingUnixTool, resolveUnixTool, testIf } from "../helpers/posix-tools";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const CHECK_LIB_LOCK = path.join(REPOSITORY_ROOT, "scripts", "check-lib-lock.ts");
const scratchRoots: string[] = [];

/**
 * Why the check does not plant an unwritable providers directory here, as the check states it: a directory's write
 * permission on Windows is an ACL, which chmod does not set, and root writes a directory whatever its mode bits. Null
 * on Linux and macOS as another user than root, where mode 0o555 refuses a new entry (POSIX).
 */
const UNWRITABLE_NOT_RUN: string | null =
  process.platform === "win32"
    ? "the unwritable providers directory step, since a directory's write permission on Windows is an ACL, which chmod does not set."
    : process.getuid?.() === 0
      ? "the unwritable providers directory step, since root writes a directory whatever its mode bits."
      : null;

afterAll(() => {
  for (const root of scratchRoots) fs.rmSync(root, { recursive: true, force: true });
});

/** A throwaway directory under the real temporary directory, removed after the file. */
function scratch(prefix: string): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), prefix));
  scratchRoots.push(root);
  return root;
}

/** A package root holding the repository's bin/ and a package.json that publishes dist and bin, with no dist yet. */
function plantedRoot(prefix: string): string {
  const root = scratch(prefix);
  const { version } = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@libredb/studio",
      version,
      files: ["dist", "bin"],
      bin: { "libredb-studio": "bin/studio.js" },
    }),
  );
  fs.cpSync(path.join(REPOSITORY_ROOT, "bin"), path.join(root, "bin"), { recursive: true });
  return root;
}

let builtModule: string;

beforeAll(async () => {
  builtModule = (
    await buildLockModule({
      root: REPOSITORY_ROOT,
      outfile: path.join(scratch("lib-lock-module-"), "providers-lock.mjs"),
    })
  ).outfile;
});

describeIf(missingUnixTool("tar"), "the packed lock command check", () => {
  test("the packed package's providers lock writes a lock Studio's reader admits, with no checkout and no download", () => {
    const root = plantedRoot("lib-lock-root-");
    fs.mkdirSync(path.join(root, "dist"));
    fs.copyFileSync(builtModule, path.join(root, "dist", "providers-lock.mjs"));
    const temp = scratch("lib-lock-temp-");

    const result = checkLibLock({ root, temp, repository: REPOSITORY_ROOT, tar: resolveUnixTool("tar") as string });

    expect(result.failures).toEqual([]);
    expect(result.packages).toEqual(["@acme/scoped 2.0.0", "acme-probe 1.0.0"]);
    expect(result.notRun).toEqual(UNWRITABLE_NOT_RUN === null ? [] : [UNWRITABLE_NOT_RUN]);
  });

  test("the check names a packed lock command that writes no lock", () => {
    const root = plantedRoot("lib-lock-stub-");
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(
      path.join(root, "dist", "providers-lock.mjs"),
      'export const USAGE = "Usage: stub";\nexport function main() {\n  console.log("Wrote nothing");\n  return 0;\n}\n',
    );
    const temp = scratch("lib-lock-stub-temp-");

    const result = checkLibLock({ root, temp, repository: REPOSITORY_ROOT, tar: resolveUnixTool("tar") as string });

    expect(result.failures).toContainEqual(expect.stringContaining("printed Wrote nothing"));
    expect(result.failures).toContainEqual(
      expect.stringContaining("dist/providers-lock.mjs of the packed package does not begin with acorn's license"),
    );
  });

  test("the check names a packed lock command that does not refuse a package making a runtime load", async () => {
    // The real command, built by the build's own function, except that it answers the refusal probe as a lock.
    const lockSource = path.join(REPOSITORY_ROOT, "scripts", "providers-lock.ts");
    const lenient = await buildLockModule({
      root: REPOSITORY_ROOT,
      outfile: path.join(scratch("lib-lock-lenient-module-"), "providers-lock.mjs"),
      entry: [
        `import { main as lock, USAGE } from ${JSON.stringify(lockSource)};`,
        "export { USAGE };",
        "export function main(argv) {",
        '  if (argv[1]?.endsWith("loads")) {',
        '    console.log("Wrote a lock over a runtime load");',
        "    return 0;",
        "  }",
        "  return lock(argv);",
        "}",
        "",
      ].join("\n"),
    });
    const root = plantedRoot("lib-lock-lenient-");
    fs.mkdirSync(path.join(root, "dist"));
    fs.copyFileSync(lenient.outfile, path.join(root, "dist", "providers-lock.mjs"));
    const temp = scratch("lib-lock-lenient-temp-");

    const result = checkLibLock({ root, temp, repository: REPOSITORY_ROOT, tar: resolveUnixTool("tar") as string });

    expect(result.failures).toEqual([
      "the packed command over a package making a runtime load exited 0, printed Wrote a lock over a runtime load on stdout and nothing on stderr, and wrote no lock, not its refusal, exit 1 and no lock.",
    ]);
    expect(result.packages).toEqual(["@acme/scoped 2.0.0", "acme-probe 1.0.0"]);
  });

  testIf(
    UNWRITABLE_NOT_RUN,
    "the check names a packed lock command that raises on an unwritable directory",
    async () => {
      // The real command, built by the build's own function, except that it raises over the unwritable probe as the
      // command did before it named that directory.
      const lockSource = path.join(REPOSITORY_ROOT, "scripts", "providers-lock.ts");
      const raising = await buildLockModule({
        root: REPOSITORY_ROOT,
        outfile: path.join(scratch("lib-lock-raising-module-"), "providers-lock.mjs"),
        entry: [
          `import { main as lock, USAGE } from ${JSON.stringify(lockSource)};`,
          "export { USAGE };",
          "export function main(argv) {",
          '  if (argv[1]?.endsWith("unwritable")) {',
          '    throw Object.assign(new Error("EACCES: planted by the test"), { code: "EACCES" });',
          "  }",
          "  return lock(argv);",
          "}",
          "",
        ].join("\n"),
      });
      const root = plantedRoot("lib-lock-raising-");
      fs.mkdirSync(path.join(root, "dist"));
      fs.copyFileSync(raising.outfile, path.join(root, "dist", "providers-lock.mjs"));
      const temp = scratch("lib-lock-raising-temp-");

      const result = checkLibLock({ root, temp, repository: REPOSITORY_ROOT, tar: resolveUnixTool("tar") as string });

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toStartWith(
        "the packed command over an unwritable providers directory exited 1, printed nothing on stdout and ",
      );
      expect(result.failures[0]).toContain("EACCES: planted by the test");
      expect(result.failures[0]).toEndWith(", not its sentence and exit 1.");
      expect(result.packages).toEqual(["@acme/scoped 2.0.0", "acme-probe 1.0.0"]);
    },
  );
});

describe("the lock command check's wiring", () => {
  test("the check refuses by name when the lock module is not built", () => {
    const root = plantedRoot("lib-lock-nomodule-");

    const run = spawnSync(process.execPath, [CHECK_LIB_LOCK], { cwd: root, encoding: "utf8", timeout: 60_000 });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      `lib:lock: ${path.join(root, "dist", "providers-lock.mjs")} is missing, so there is no lock command to pack. Run bun run build:lib first.`,
    );
  });

  test("package.json runs the check as lib:lock, and ci.yml runs it in the build job right after lib:load", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));
    expect(manifest.scripts["lib:lock"]).toBe("bun scripts/check-lib-lock.ts");

    const workflow = parse(fs.readFileSync(path.join(REPOSITORY_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, { steps: { run?: string }[] }>;
    };
    const runs = workflow.jobs["lint-and-build"].steps.map((step) => step.run ?? "");
    const load = runs.indexOf("bun run lib:load");
    expect(load).toBeGreaterThanOrEqual(0);
    expect(runs[load + 1]).toBe("bun run lib:lock");
  });
});
