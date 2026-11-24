/**
 * Unit tests for the seed assets directory the deb/rpm and Homebrew wrappers hand
 * the server (docs/DISTRIBUTION.md, "Built-in sample assets"). Each wrapper is
 * exercised as a real subprocess against a stub "node" binary that only echoes the
 * SEED_ASSETS_DIR it was started with, on the harness of
 * packaging-bind-address.test.ts - no real server ever starts.
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { MISSING_POSIX_FILE_MODES, describeIf, missingPosixShell, posixShell } from "../helpers/posix-tools";

/*
  Both wrappers are shell files shipped in the .deb/.rpm and in the Homebrew formula, and each is
  exercised against a stub `node` that is itself a `#!/bin/sh` script made runnable with chmod 0755.
  Windows has neither the shells on a PowerShell PATH nor a mode bit for the stub, and there is no
  Windows artifact behind these wrappers, so the skip names that (packaging-bind-address.test.ts).
*/
const SH = posixShell("sh");
const BASH = posixShell("bash");
const NO_SH = missingPosixShell("sh") ?? MISSING_POSIX_FILE_MODES;
const NO_BASH = missingPosixShell("bash") ?? MISSING_POSIX_FILE_MODES;

const STUB_NODE_SCRIPT = '#!/bin/sh\necho "SEED_ASSETS_DIR=$SEED_ASSETS_DIR"\n';

const TEMPLATE = readFileSync(join(import.meta.dir, "../../packaging/homebrew/libredb-studio.rb.tmpl"), "utf8");

function writeStubNode(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const nodePath = join(binDir, "node");
  writeFileSync(nodePath, STUB_NODE_SCRIPT);
  chmodSync(nodePath, 0o755);
  return nodePath;
}

/** The ambient environment without SEED_ASSETS_DIR, so a contributor's own value never decides a case. */
function ambientEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.SEED_ASSETS_DIR;
  return env;
}

describeIf(NO_SH, "packaging/linux/libredb-studio seed assets directory", () => {
  const WRAPPER = join(import.meta.dir, "../../packaging/linux/libredb-studio");
  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /**
   * Run the wrapper against a fresh fixture home. With `relativeHome`, the wrapper runs from the home's
   * parent directory and gets the home as its bare name, the way a caller in an extracted package tree would.
   */
  function runWrapper(env: Record<string, string> = {}, { relativeHome = false } = {}) {
    const home = mkdtempSync(join(tmpdir(), "libredb-deb-seed-assets-"));
    fixtureRoots.push(home);
    writeStubNode(join(home, "node/bin"));
    writeFileSync(join(home, "server.js"), "");
    const result = Bun.spawnSync([SH!, WRAPPER], {
      cwd: relativeHome ? dirname(home) : undefined,
      env: {
        ...ambientEnv(),
        LIBREDB_STUDIO_HOME: relativeHome ? basename(home) : home,
        HOME: home,
        INVOCATION_ID: "",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, `wrapper stderr: ${result.stderr.toString()}`).toBe(0);
    return { output: result.stdout.toString(), home };
  }

  test("points SEED_ASSETS_DIR at the payload's seed-assets on a direct run", () => {
    const { output, home } = runWrapper();
    expect(output).toContain(`SEED_ASSETS_DIR=${join(home, "seed-assets")}\n`);
  });

  test("points it there under systemd too, where the unit sets none", () => {
    const { output, home } = runWrapper({ INVOCATION_ID: "e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2" });
    expect(output).toContain(`SEED_ASSETS_DIR=${join(home, "seed-assets")}\n`);
  });

  test("treats an empty SEED_ASSETS_DIR as unset", () => {
    const { output, home } = runWrapper({ SEED_ASSETS_DIR: "" });
    expect(output).toContain(`SEED_ASSETS_DIR=${join(home, "seed-assets")}\n`);
  });

  test("hands an absolute SEED_ASSETS_DIR when LIBREDB_STUDIO_HOME is relative", () => {
    // server.js changes into its own directory before it reads SEED_ASSETS_DIR, so a relative value
    // would resolve against the payload instead of the directory the wrapper was run from.
    // realpath: on macOS the temp directory is a symlink, and `pwd -P` reports its target.
    const { output, home } = runWrapper({}, { relativeHome: true });
    expect(output).toContain(`SEED_ASSETS_DIR=${join(realpathSync(home), "seed-assets")}\n`);
  });

  test("stops with an error when a relative LIBREDB_STUDIO_HOME does not exist", () => {
    const parent = mkdtempSync(join(tmpdir(), "libredb-deb-seed-assets-"));
    fixtureRoots.push(parent);
    const result = Bun.spawnSync([SH!, WRAPPER], {
      cwd: parent,
      env: { ...ambientEnv(), LIBREDB_STUDIO_HOME: "missing-home", HOME: parent, INVOCATION_ID: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("missing-home");
  });

  test("keeps an operator's SEED_ASSETS_DIR", () => {
    expect(runWrapper({ SEED_ASSETS_DIR: "/srv/own-seed-assets" }).output).toContain(
      "SEED_ASSETS_DIR=/srv/own-seed-assets\n",
    );
  });
});

describeIf(NO_BASH, "packaging/homebrew/libredb-studio.rb.tmpl seed assets directory", () => {
  const heredocMatch = /\(bin\/"libredb-studio"\)\.write <<~SCRIPT\n([\s\S]*?)\n\s*SCRIPT\b/.exec(TEMPLATE);
  if (!heredocMatch) throw new Error('could not locate the bin/"libredb-studio" heredoc in the Homebrew template');
  const rawScript = heredocMatch[1];

  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function runWrapper(env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "libredb-brew-seed-assets-"));
    fixtureRoots.push(dir);
    const libexec = join(dir, "keg-libexec");
    const nodePath = writeStubNode(join(dir, "node-bin"));
    mkdirSync(libexec, { recursive: true });
    writeFileSync(join(libexec, "server.js"), "");
    const script = rawScript
      .replaceAll('#{Formula["node@24"].opt_bin}/node', nodePath)
      .replaceAll("#{var}", join(dir, "brew-var"))
      .replaceAll("#{libexec}", libexec);
    const result = Bun.spawnSync([BASH!, "-c", script], {
      env: { ...ambientEnv(), HOME: dir, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, `wrapper stderr: ${result.stderr.toString()}`).toBe(0);
    return { output: result.stdout.toString(), libexec };
  }

  test("points SEED_ASSETS_DIR at the keg's libexec/seed-assets", () => {
    const { output, libexec } = runWrapper();
    expect(output).toContain(`SEED_ASSETS_DIR=${join(libexec, "seed-assets")}\n`);
  });

  test("treats an empty SEED_ASSETS_DIR as unset", () => {
    const { output, libexec } = runWrapper({ SEED_ASSETS_DIR: "" });
    expect(output).toContain(`SEED_ASSETS_DIR=${join(libexec, "seed-assets")}\n`);
  });

  test("keeps an operator's SEED_ASSETS_DIR", () => {
    expect(runWrapper({ SEED_ASSETS_DIR: "/opt/own-seed-assets" }).output).toContain(
      "SEED_ASSETS_DIR=/opt/own-seed-assets\n",
    );
  });
});

test("brew services runs the wrapper, so the service gets the same seed assets directory", () => {
  // The wrapper is the one place the Homebrew install sets SEED_ASSETS_DIR; a service block that ran
  // server.js itself would bypass it.
  const service = /\n\s*service do\n([\s\S]*?)\n\s*end\b/.exec(TEMPLATE)?.[1];
  expect(service).toBeDefined();
  expect(service).toMatch(/^\s*run \[opt_bin\/"libredb-studio"\]$/m);
});
