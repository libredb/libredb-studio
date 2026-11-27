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
import { describeIf, missingUnixTool, resolveUnixTool } from "../helpers/posix-tools";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const CHECK_LIB_LOCK = path.join(REPOSITORY_ROOT, "scripts", "check-lib-lock.ts");
const scratchRoots: string[] = [];

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
