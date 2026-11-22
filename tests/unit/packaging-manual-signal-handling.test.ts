/**
 * Unit tests for the exit owner the deb/rpm/AUR and Homebrew wrappers hand the server
 * (docs/DISTRIBUTION.md, "Stopping the server"): NEXT_MANUAL_SIG_HANDLE=true, so Studio's shutdown handler ends it,
 * unless the operator set a value, which is kept as given, the empty one included. Each wrapper is exercised as a
 * real subprocess against a stub "node" binary that only echoes the variable it was started with, on the harness of
 * packaging-seed-assets-dir.test.ts - no real server ever starts.
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MISSING_POSIX_FILE_MODES, describeIf, missingPosixShell, posixShell } from "../helpers/posix-tools";

/*
  Both wrappers are shell files shipped in the .deb/.rpm/AUR packages and in the Homebrew formula, and each is
  exercised against a stub `node` that is itself a `#!/bin/sh` script made runnable with chmod 0755. Windows has
  neither the shells on a PowerShell PATH nor a mode bit for the stub, and there is no Windows artifact behind these
  wrappers, so the skip names that (packaging-bind-address.test.ts).
*/
const SH = posixShell("sh");
const BASH = posixShell("bash");
const NO_SH = missingPosixShell("sh") ?? MISSING_POSIX_FILE_MODES;
const NO_BASH = missingPosixShell("bash") ?? MISSING_POSIX_FILE_MODES;

const REPO_ROOT = join(import.meta.dir, "../..");
/** `-` and not `:-`: an empty value is printed as empty, not as `<unset>`. */
const STUB_NODE_SCRIPT = '#!/bin/sh\necho "NEXT_MANUAL_SIG_HANDLE=${NEXT_MANUAL_SIG_HANDLE-<unset>}"\n';
const TEMPLATE = readFileSync(join(REPO_ROOT, "packaging/homebrew/libredb-studio.rb.tmpl"), "utf8");
const SYSTEMD_INVOCATION_ID = "e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2";

function writeStubNode(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const nodePath = join(binDir, "node");
  writeFileSync(nodePath, STUB_NODE_SCRIPT);
  chmodSync(nodePath, 0o755);
  return nodePath;
}

/** The ambient environment without NEXT_MANUAL_SIG_HANDLE, so a contributor's own value never decides a case. */
function ambientEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.NEXT_MANUAL_SIG_HANDLE;
  return env;
}

describeIf(NO_SH, "packaging/linux/libredb-studio NEXT_MANUAL_SIG_HANDLE", () => {
  const WRAPPER = join(REPO_ROOT, "packaging/linux/libredb-studio");
  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function runWrapper(env: Record<string, string> = {}): string {
    const home = mkdtempSync(join(tmpdir(), "libredb-deb-manual-signal-"));
    fixtureRoots.push(home);
    writeStubNode(join(home, "node/bin"));
    writeFileSync(join(home, "server.js"), "");
    const result = Bun.spawnSync([SH!, WRAPPER], {
      env: { ...ambientEnv(), LIBREDB_STUDIO_HOME: home, HOME: home, INVOCATION_ID: "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, `wrapper stderr: ${result.stderr.toString()}`).toBe(0);
    return result.stdout.toString();
  }

  test("hands the server NEXT_MANUAL_SIG_HANDLE=true on a direct run", () => {
    expect(runWrapper()).toContain("NEXT_MANUAL_SIG_HANDLE=true\n");
  });

  test("hands it under systemd too, where the unit sets none", () => {
    expect(runWrapper({ INVOCATION_ID: SYSTEMD_INVOCATION_ID })).toContain("NEXT_MANUAL_SIG_HANDLE=true\n");
  });

  test("keeps an operator's empty NEXT_MANUAL_SIG_HANDLE, which leaves the exit to Next.js's handler", () => {
    expect(runWrapper({ INVOCATION_ID: SYSTEMD_INVOCATION_ID, NEXT_MANUAL_SIG_HANDLE: "" })).toContain(
      "NEXT_MANUAL_SIG_HANDLE=\n",
    );
  });

  test("keeps an operator's other value for the server to refuse by name", () => {
    expect(runWrapper({ NEXT_MANUAL_SIG_HANDLE: "1" })).toContain("NEXT_MANUAL_SIG_HANDLE=1\n");
  });
});

test("the .deb, .rpm and AUR unit runs the wrapper and sets no NEXT_MANUAL_SIG_HANDLE of its own, so the env file decides", () => {
  const unit = readFileSync(join(REPO_ROOT, "packaging/linux/libredb-studio.service"), "utf8");
  const lines = unit.split("\n").map((line) => line.trim());
  expect(lines).toContain("ExecStart=/usr/bin/libredb-studio");
  expect(lines.filter((line) => line.startsWith("Environment=") && line.includes("NEXT_MANUAL_SIG_HANDLE"))).toEqual(
    [],
  );
  // systemd applies the assignments in order, so the operator's EnvironmentFile comes after every Environment= line.
  const environmentFile = lines.indexOf("EnvironmentFile=-/etc/libredb-studio/env");
  expect(environmentFile).toBeGreaterThan(-1);
  expect(lines.findLastIndex((line) => line.startsWith("Environment="))).toBeLessThan(environmentFile);
});

describeIf(NO_BASH, "packaging/homebrew/libredb-studio.rb.tmpl NEXT_MANUAL_SIG_HANDLE", () => {
  const heredocMatch = /\(bin\/"libredb-studio"\)\.write <<~SCRIPT\n([\s\S]*?)\n\s*SCRIPT\b/.exec(TEMPLATE);
  if (!heredocMatch) throw new Error('could not locate the bin/"libredb-studio" heredoc in the Homebrew template');
  const rawScript = heredocMatch[1];
  const fixtureRoots: string[] = [];

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function runWrapper(env: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "libredb-brew-manual-signal-"));
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
    return result.stdout.toString();
  }

  test("hands the server NEXT_MANUAL_SIG_HANDLE=true", () => {
    expect(runWrapper()).toContain("NEXT_MANUAL_SIG_HANDLE=true\n");
  });

  test("keeps an operator's empty NEXT_MANUAL_SIG_HANDLE, which leaves the exit to Next.js's handler", () => {
    expect(runWrapper({ NEXT_MANUAL_SIG_HANDLE: "" })).toContain("NEXT_MANUAL_SIG_HANDLE=\n");
  });

  test("keeps an operator's other value for the server to refuse by name", () => {
    expect(runWrapper({ NEXT_MANUAL_SIG_HANDLE: "1" })).toContain("NEXT_MANUAL_SIG_HANDLE=1\n");
  });
});
