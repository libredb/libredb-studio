/**
 * The lock command (scripts/providers-lock.ts, `bun run providers:lock -- --dir <directory>`): it writes the lock of
 * every `<name>/<version>/` artifact in a providers directory with the functions Studio's own read uses, so the lock it
 * writes is read unchanged and a later edit is refused; it refuses a directory it cannot lock and writes nothing then.
 *
 * Each case spawns the command from the repository root, as an operator runs it, under a timeout, with `--silent` so
 * that `bun run` adds no line of its own to what the command prints.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { LOCK_FILE_NAME } from "@/lib/provider-host/providers-dir";
import { readProvidersLock } from "@/lib/provider-host/providers-lock";
import {
  artifactDirectoryOf,
  type FixturePackage,
  lockEntryOf,
  removeScratch,
  scratchDirectory,
  writeArtifact,
} from "../../helpers/provider-artifacts";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const USAGE = "Usage: bun run providers:lock -- --dir <absolute directory>";
const scratch = scratchDirectory("libredb-providers-lock-command-");
let counter = 0;

afterAll(() => {
  removeScratch(scratch);
});

/** A new empty providers directory under the scratch root. */
function freshProviders(): string {
  counter += 1;
  const directory = path.join(scratch, `providers-${counter}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

/** Runs the command with `args` from the repository root, and answers how it ended. */
function runCommand(...args: string[]): { exitCode: number | null; stdout: string; stderr: string } {
  const run = Bun.spawnSync([process.execPath, "run", "--silent", "providers:lock", "--", ...args], {
    cwd: REPOSITORY_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

const FOO: FixturePackage = { name: "acme-foo", version: "1.0.0", engines: ["acmefoob", "acmefooa"] };
const BAR: FixturePackage = { name: "@acme/bar", version: "2.3.4-rc.1", engines: ["acmebar"], entry: "lib/bar.js" };

describe("the lock command", () => {
  test("the lock the command writes is admitted unchanged, and a later edit to the artifact is refused", () => {
    const providers = freshProviders();
    writeArtifact(providers, FOO);
    writeArtifact(providers, BAR);

    const run = runCommand("--dir", providers);
    expect([run.exitCode, run.stderr]).toEqual([0, ""]);
    const lock = path.join(providers, LOCK_FILE_NAME);
    expect(run.stdout).toBe(
      [
        `Wrote ${lock}`,
        `@acme/bar 2.3.4-rc.1 ${lockEntryOf(providers, BAR).digest}`,
        `acme-foo 1.0.0 ${lockEntryOf(providers, FOO).digest}`,
        "",
      ].join("\n"),
    );
    const read = readProvidersLock(providers);
    expect(read.read && read.packages.map((pkg) => [pkg.name, pkg.verified])).toEqual([
      ["@acme/bar", true],
      ["acme-foo", true],
    ]);

    fs.appendFileSync(path.join(artifactDirectoryOf(providers, FOO), "dist", "index.mjs"), "// edited\n");
    const edited = readProvidersLock(providers);
    expect(
      edited.read &&
        edited.packages.map((pkg) => [pkg.name, pkg.verified ? "verified" : `${pkg.refusal.code} ${pkg.refusal.rule}`]),
    ).toEqual([
      ["@acme/bar", "verified"],
      ["acme-foo", "PROVIDER_DIGEST_MISMATCH digest-differs"],
    ]);
  });

  test("the command writes the same bytes for the same directory, entries by name and engines in order", () => {
    const providers = freshProviders();
    writeArtifact(providers, FOO);
    writeArtifact(providers, BAR);
    expect(runCommand("--dir", providers).exitCode).toBe(0);
    const lock = path.join(providers, LOCK_FILE_NAME);
    const first = fs.readFileSync(lock, "utf8");
    expect(runCommand(`--dir=${providers}`).exitCode).toBe(0);
    expect(fs.readFileSync(lock, "utf8")).toBe(first);

    const expected = {
      lockVersion: 1,
      entries: [
        { ...lockEntryOf(providers, BAR) },
        { ...lockEntryOf(providers, FOO), engines: ["acmefooa", "acmefoob"] },
      ],
    };
    expect(first).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(fs.readdirSync(providers).sort()).toEqual(["@acme", "acme-foo", LOCK_FILE_NAME]);

    const empty = freshProviders();
    expect(runCommand("--dir", empty).exitCode).toBe(0);
    expect(fs.readFileSync(path.join(empty, LOCK_FILE_NAME), "utf8")).toBe(
      '{\n  "lockVersion": 1,\n  "entries": []\n}\n',
    );
  });

  test("the command refuses a relative or missing --dir and any other argument with its usage and exit 2", () => {
    const providers = freshProviders();
    for (const args of [
      [],
      ["--dir"],
      ["--dir", "relative/providers"],
      ["--dir=relative"],
      ["--dir", providers, "--extra"],
      ["--other"],
      ["--dir="],
    ]) {
      const run = runCommand(...args);
      expect([args, run.exitCode, run.stdout, run.stderr]).toEqual([args, 2, "", `${USAGE}\n`]);
    }
    expect(fs.existsSync(path.join(providers, LOCK_FILE_NAME))).toBe(false);
  });

  test("the command writes nothing and exits 1 when an artifact is refused, printing every refusal", () => {
    const providers = freshProviders();
    writeArtifact(providers, FOO);
    const linked = { name: "acme-linked", version: "1.0.0", engines: ["acmelinked"] };
    writeArtifact(providers, linked);
    fs.symlinkSync(providers, path.join(artifactDirectoryOf(providers, linked), "loop"), "junction");
    const renamed = { name: "acme-renamed", version: "1.0.0", engines: ["acmerenamed"] };
    fs.writeFileSync(
      path.join(writeArtifact(providers, renamed), "package.json"),
      JSON.stringify({ name: "acme-other", version: "1.0.0" }),
    );
    const noEntry = { name: "acme-no-entry", version: "1.0.0", engines: ["acmenoentry"] };
    fs.rmSync(path.join(writeArtifact(providers, noEntry), "dist", "index.mjs"));

    const run = runCommand("--dir", providers);
    expect([run.exitCode, run.stdout]).toEqual([1, ""]);
    expect(run.stderr).toBe(
      [
        "PROVIDER_PATH_OUTSIDE: acme-linked 1.0.0: its directory holds a symbolic link or junction, which is never followed",
        "PROVIDER_PATH_OUTSIDE: acme-no-entry 1.0.0: the entry its manifest names is not a regular file of its directory",
        "PROVIDER_IDENTITY_MISMATCH: acme-renamed 1.0.0: its package.json names another package name",
        "providers:lock wrote nothing",
        "",
      ].join("\n"),
    );
    expect(fs.existsSync(path.join(providers, LOCK_FILE_NAME))).toBe(false);

    const absent = path.join(providers, "absent");
    const missing = runCommand("--dir", absent);
    expect([missing.exitCode, missing.stdout, missing.stderr]).toEqual([
      1,
      "",
      `providers:lock: ${absent}: the providers directory does not exist\nproviders:lock wrote nothing\n`,
    ]);
  });

  test("the command refuses an entry of the directory that is neither a package nor the lock, and two versions of one package", () => {
    const providers = freshProviders();
    writeArtifact(providers, FOO);
    writeArtifact(providers, { ...FOO, version: "1.1.0" });
    writeArtifact(providers, BAR);
    fs.writeFileSync(path.join(providers, "notes.txt"), "not a package\n");
    fs.mkdirSync(path.join(providers, "Upper", "1.0.0"), { recursive: true });
    fs.mkdirSync(path.join(providers, "acme-versionless", "latest"), { recursive: true });
    fs.writeFileSync(path.join(providers, "@acme", "loose.txt"), "");

    const run = runCommand("--dir", providers);
    expect([run.exitCode, run.stdout]).toEqual([1, ""]);
    expect(run.stderr).toBe(
      [
        `providers:lock: ${path.join("@acme", "loose.txt")}: neither a package nor the lock`,
        "providers:lock: Upper: neither a package nor the lock",
        "providers:lock: acme-foo: two versions of one package",
        `providers:lock: ${path.join("acme-versionless", "latest")}: not a version of the package`,
        "providers:lock: notes.txt: neither a package nor the lock",
        "providers:lock wrote nothing",
        "",
      ].join("\n"),
    );
    expect(fs.existsSync(path.join(providers, LOCK_FILE_NAME))).toBe(false);
  });

  test("package.json runs the command as providers:lock", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));
    expect(manifest.scripts["providers:lock"]).toBe("bun scripts/providers-lock.ts");
    expect(fs.existsSync(path.join(REPOSITORY_ROOT, "scripts", "providers-lock.ts"))).toBe(true);
  });
});
