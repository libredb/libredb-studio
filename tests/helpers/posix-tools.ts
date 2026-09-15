/**
 * Explicit resolution for the POSIX shell and the unix tools the packaging tests drive, plus the
 * skip helpers that make an unavailable one visible instead of silent.
 *
 * Spawning `bash`, `sh`, `grep`, `tar`, `unzip` or `7z` by bare name is a bet on PATH, and on
 * Windows it is a bet that loses twice. A contributor runs `bun run test` from PowerShell, where
 * Git for Windows puts only `C:\Program Files\Git\cmd` (git.exe) on PATH - `usr\bin` and `bin`,
 * which hold bash.exe, sh.exe, grep.exe and unzip.exe, are not on it. `Bun.spawnSync` THROWS
 * ("Executable not found in $PATH") rather than returning a non-zero exit code, so one bare name
 * takes the whole file down at its first spawn. And when WSL is installed `bash` DOES resolve, to
 * `C:\Windows\System32\bash.exe` - a Linux shell that cannot stat the Win32 temp path every fixture
 * hands it, so the script under test looks broken when nothing is.
 *
 * So the tool is resolved to an absolute path, from the Git for Windows installation the clone
 * already needed, and when there is none the test says so by name rather than passing quietly.
 *
 * The lookup is injected rather than read from `process` directly, so the win32 branch is driven
 * from Linux in tests/unit/posix-tools.test.ts: a platform branch nothing can execute is a branch
 * nothing checks.
 */
import { describe, test } from "bun:test";
import { existsSync } from "node:fs";

/** Everything the resolver touches outside itself. */
export interface ToolLookup {
  /** `process.platform` of the machine being resolved for. */
  readonly platform: string;
  /** PATH lookup; null when the command is not on PATH. */
  which(command: string): string | null;
  /** True when the path names something that exists. */
  exists(candidate: string): boolean;
  /** `git --exec-path` for this git binary, or null when it does not answer. */
  gitExecPath(gitBinary: string): string | null;
  /** `%LOCALAPPDATA%`, where a per-user Git for Windows install lands. */
  readonly localAppData: string | null;
}

/** The real machine. */
export const systemLookup: ToolLookup = {
  platform: process.platform,
  which: (command) => Bun.which(command),
  exists: (candidate) => existsSync(candidate),
  gitExecPath: (gitBinary) => {
    const run = Bun.spawnSync([gitBinary, "--exec-path"], { stdout: "pipe", stderr: "pipe" });
    return run.exitCode === 0 ? run.stdout.toString().trim() : null;
  },
  localAppData: process.env.LOCALAPPDATA ?? null,
};

/**
 * Where Git for Windows keeps the tools: `bin` first because the bash.exe and sh.exe there are the
 * wrappers that put `usr/bin` on the shell's own PATH, while `usr/bin` is where everything else
 * (grep, tar, unzip) actually lives. Looking in that order gets both right with one list.
 */
const GIT_TOOL_DIRS = ["bin", "usr/bin"];

/** System-wide Git for Windows installs, for a machine whose PATH does not carry git at all. */
const DEFAULT_GIT_ROOTS = ["C:/Program Files/Git", "C:/Program Files (x86)/Git"];

/** The shells WSL shadows. tar.exe and curl.exe in System32 are the genuine articles; bash.exe is not. */
const WSL_SHADOWED_SHELLS = new Set(["sh", "bash"]);

const forwardSlashes = (candidate: string): string => candidate.replaceAll("\\", "/");

/** WSL's bash.exe lives in %SystemRoot%\System32, and it is a Linux shell, not a Windows one. */
const isSystem32 = (candidate: string): boolean => /\/windows\/system32\//i.test(forwardSlashes(candidate));

/** Installation roots to search, most specific first. */
function gitForWindowsRoots(lookup: ToolLookup): string[] {
  const roots: string[] = [];
  const git = lookup.which("git");
  if (git !== null) {
    const execPath = lookup.gitExecPath(git);
    // `git --exec-path` prints <root>/mingw64/libexec/git-core, so the installation root is three
    // levels up. Asking git itself beats guessing: it finds a portable or D:-drive install too.
    if (execPath !== null) {
      const segments = forwardSlashes(execPath).split("/");
      if (segments.length > 3) roots.push(segments.slice(0, -3).join("/"));
    }
  }
  if (lookup.localAppData !== null) roots.push(`${forwardSlashes(lookup.localAppData)}/Programs/Git`);
  roots.push(...DEFAULT_GIT_ROOTS);
  return roots;
}

/** The absolute path of `name`, or null when this machine has no such tool. */
export function resolveUnixTool(name: string, lookup: ToolLookup = systemLookup): string | null {
  if (lookup.platform !== "win32") return lookup.which(name);
  const onPath = lookup.which(name);
  if (onPath !== null && !(WSL_SHADOWED_SHELLS.has(name) && isSystem32(onPath))) return onPath;
  for (const root of gitForWindowsRoots(lookup)) {
    for (const dir of GIT_TOOL_DIRS) {
      const candidate = `${root}/${dir}/${name}.exe`;
      if (lookup.exists(candidate)) return candidate;
    }
  }
  return null;
}

/** The POSIX shell to spawn, e.g. `Bun.spawnSync([posixShell(), SCRIPT, ...])`. */
export function posixShell(name: "sh" | "bash" = "bash", lookup: ToolLookup = systemLookup): string | null {
  return resolveUnixTool(name, lookup);
}

/** Null when the shell is there, else the sentence that goes in the skipped title. */
export function missingPosixShell(name: "sh" | "bash" = "bash", lookup: ToolLookup = systemLookup): string | null {
  return posixShell(name, lookup) === null
    ? `no POSIX ${name}: none on PATH and no Git for Windows installation carries one`
    : null;
}

/** Null when the tool is there, else the sentence that goes in the skipped title. */
export function missingUnixTool(name: string, lookup: ToolLookup = systemLookup): string | null {
  return resolveUnixTool(name, lookup) === null
    ? `no ${name}: not on PATH and not in a Git for Windows installation`
    : null;
}

/**
 * Null on Linux and macOS, a reason on Windows. NTFS carries no POSIX mode bits (chmod there only
 * toggles the read-only flag, and stat reads back 0o666 or 0o444), and CreateProcess cannot exec an
 * extension-less `#!` script, so a fixture that stands a `chmod 0755` stub on PATH has nothing to
 * stand. Platform rather than a probe on purpose: a probe that answers "no" on Linux would turn a
 * real regression into a skip.
 */
export const MISSING_POSIX_FILE_MODES: string | null =
  process.platform === "win32"
    ? "POSIX file modes: NTFS has no exec bit and Windows cannot exec an extension-less #! stub"
    : null;

/** `describe` when `missing` is null, else a skipped describe whose title carries the reason. */
export function describeIf(missing: string | null, title: string, body: () => void): void {
  if (missing === null) {
    describe(title, body);
    return;
  }
  // bun prints a skipped test's title NOWHERE: measured on 1.4.2 piped, with FORCE_COLOR, and under
  // a real pty, its output carries the count and nothing else. Two readers need the reason anyway.
  // `bun run test` gets it from bun's junit report, which the runner asks every child for and prints
  // under the file in its summary; somebody running this one file directly gets it from this line.
  console.warn(`posix-tools: skipping "${title}" - ${missing}`);
  describe.skip(`${title} [skipped: ${missing}]`, body);
}

/**
 * `test` when `missing` is null, else a skipped test whose title carries the reason.
 *
 * The body may be async: bun awaits what it returns, so an assertion after an `await` still fails
 * the test (measured - an async body whose post-await expect fails reports as a failure here too).
 */
export function testIf(missing: string | null, title: string, body: () => void | Promise<unknown>): void {
  if (missing === null) {
    test(title, body);
    return;
  }
  console.warn(`posix-tools: skipping "${title}" - ${missing}`);
  test.skip(`${title} [skipped: ${missing}]`, body);
}

/** The common case: a describe that needs a POSIX shell and nothing else. */
export function describeIfPosixShell(shell: "sh" | "bash", title: string, body: () => void): void {
  describeIf(missingPosixShell(shell), title, body);
}
