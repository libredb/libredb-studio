/**
 * The `libredb-studio` command of Homebrew, the Linux packages (deb, rpm, AUR) and Windows runs the standalone server,
 * which ignores its arguments, so `libredb-studio providers lock --dir x` there would start a second server.
 * Each launcher refuses a first argument `providers` by one sentence naming where the lock command runs (npx or an
 * image), exit 2 as the image wrapper's usage does, before anything else; serving the command there waits for a
 * providers directory per channel.
 *
 * The two shell launchers run as real subprocesses against a stub `node` that writes a marker file when it runs, so
 * "starts no server" is the marker's absence, and a control run with no argument shows the stub does run. The
 * Homebrew wrapper is the heredoc of the formula template, run under bash, its own shebang, as every sibling Homebrew
 * harness runs it (packaging-manual-signal-handling.test.ts); the refusal block itself is POSIX. The Windows launcher's
 * behaviour is held by its Go tests (packaging/windows/launcher/launch_test.go); this file holds its sentence equal to
 * the shell launchers' one.
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MISSING_POSIX_FILE_MODES, describeIf, missingPosixShell, posixShell } from "../helpers/posix-tools";

/*
  Both shell launchers are exercised against a stub `node` that is itself a `#!/bin/sh` script made runnable with
  chmod 0755. Windows has neither the shells on a PowerShell PATH nor a mode bit for the stub, and no Windows artifact
  ships these launchers, so the skip names that (packaging-bind-address.test.ts).
*/
const SH = posixShell("sh");
const BASH = posixShell("bash");
const NO_SH = missingPosixShell("sh") ?? MISSING_POSIX_FILE_MODES;
const NO_BASH = missingPosixShell("bash") ?? MISSING_POSIX_FILE_MODES;

const REPO_ROOT = join(import.meta.dir, "../..");
const TEMPLATE = readFileSync(join(REPO_ROOT, "packaging/homebrew/libredb-studio.rb.tmpl"), "utf8");

/** The one sentence every launcher prints, verbatim. */
const SENTENCE =
  "libredb-studio: this install does not run providers lock; run npx @libredb/studio providers lock --dir <absolute directory>, or libredb-studio providers lock --dir <absolute directory> in a LibreDB Studio container image.";

/** The arguments each launcher must refuse. */
const REFUSED: string[][] = [["providers", "lock", "--dir", "x"], ["providers"], ["providers", "--help"]];

/** What a launcher run answered, and whether the stub server ran. */
interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  started: boolean;
}

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A scratch directory removed after the case. */
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  fixtureRoots.push(dir);
  return dir;
}

/** A stub `node` in `binDir` that writes `marker` when it runs; answers its path. */
function writeStubNode(binDir: string, marker: string): string {
  mkdirSync(binDir, { recursive: true });
  const nodePath = join(binDir, "node");
  writeFileSync(nodePath, `#!/bin/sh\n: > '${marker}'\n`);
  chmodSync(nodePath, 0o755);
  return nodePath;
}

/** Runs one launcher command line and reads the marker. */
function run(command: string[], env: Record<string, string>, marker: string): Run {
  const result = Bun.spawnSync(command, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    started: existsSync(marker),
  };
}

/** What every refused run answers. */
const REFUSAL: Run = {
  exitCode: 2,
  stdout: "",
  stderr: `${SENTENCE}\n`,
  started: false,
};

describeIf(NO_BASH, "packaging/homebrew/libredb-studio.rb.tmpl providers refusal", () => {
  const heredocMatch = /\(bin\/"libredb-studio"\)\.write <<~SCRIPT\n([\s\S]*?)\n\s*SCRIPT\b/.exec(TEMPLATE);
  if (!heredocMatch) throw new Error('could not locate the bin/"libredb-studio" heredoc in the Homebrew template');
  const rawScript = heredocMatch[1];

  /** Runs the wrapper with `args`, its node and payload under a fresh scratch directory. */
  function runWrapper(args: string[]): Run {
    const dir = scratch("libredb-brew-providers-");
    const marker = join(dir, "server-started");
    const nodePath = writeStubNode(join(dir, "node-bin"), marker);
    const libexec = join(dir, "keg-libexec");
    mkdirSync(libexec, { recursive: true });
    writeFileSync(join(libexec, "server.js"), "");
    const script = rawScript
      .replaceAll('#{Formula["node@24"].opt_bin}/node', nodePath)
      .replaceAll("#{var}", join(dir, "brew-var"))
      .replaceAll("#{libexec}", libexec);
    return run([BASH!, "-c", script, "libredb-studio", ...args], { HOME: dir }, marker);
  }

  test("the Homebrew wrapper refuses providers by one sentence and starts no server", () => {
    for (const args of REFUSED) expect([args, runWrapper(args)]).toEqual([args, REFUSAL]);
    expect(runWrapper([])).toEqual({ exitCode: 0, stdout: "", stderr: "", started: true });
  });

  test("the Homebrew wrapper holds no backslash, which Ruby's heredoc would rewrite", () => {
    expect(rawScript).not.toContain("\\");
  });
});

describeIf(NO_SH, "packaging/linux/libredb-studio providers refusal", () => {
  const WRAPPER = join(REPO_ROOT, "packaging/linux/libredb-studio");

  /** Runs the launcher with `args` against a payload home holding the stub node, or against `home` when given. */
  function runWrapper(args: string[], home?: string): Run {
    const dir = scratch("libredb-deb-providers-");
    const marker = join(dir, "server-started");
    writeStubNode(join(dir, "node/bin"), marker);
    writeFileSync(join(dir, "server.js"), "");
    return run([SH!, WRAPPER, ...args], { LIBREDB_STUDIO_HOME: home ?? dir, HOME: dir, INVOCATION_ID: "" }, marker);
  }

  test("the Linux launcher refuses providers by one sentence and starts no server", () => {
    for (const args of REFUSED) expect([args, runWrapper(args)]).toEqual([args, REFUSAL]);
    // The refusal comes before the home's resolution, so a home that does not exist still gets the sentence.
    const missing = "libredb-studio-home-that-does-not-exist";
    expect(runWrapper(["providers", "lock"], missing)).toEqual(REFUSAL);
    expect(runWrapper([])).toEqual({ exitCode: 0, stdout: "", stderr: "", started: true });
  });
});

test("the Windows launcher prints the same sentence", () => {
  const source = readFileSync(join(REPO_ROOT, "packaging/windows/launcher/launch.go"), "utf8");
  expect(source).toContain(`"${SENTENCE}"`);
});
