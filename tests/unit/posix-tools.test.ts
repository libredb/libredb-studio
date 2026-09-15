/**
 * Unit tests for tests/helpers/posix-tools.ts - the explicit resolution of the POSIX shell and the
 * unix tools the packaging tests drive.
 *
 * The whole point of the helper is the Windows branch, and the machine running this is not Windows,
 * so every case below drives an INJECTED lookup: a platform branch that only a Windows contributor
 * can execute is a branch nobody checks until it breaks on their laptop. The real lookup is
 * exercised too, directly, because "ask git where it lives" has to be a measurement rather than a
 * shape.
 */
import { describe, expect, test } from "bun:test";
import {
  MISSING_POSIX_FILE_MODES,
  type ToolLookup,
  describeIf,
  describeIfPosixShell,
  missingPosixShell,
  missingUnixTool,
  posixShell,
  resolveUnixTool,
  systemLookup,
  testIf,
} from "../helpers/posix-tools";

const GIT_ROOT = "C:/Program Files/Git";
/** What `git --exec-path` prints on Windows, verbatim shape: forward slashes, three levels deep. */
const GIT_EXEC_PATH = `${GIT_ROOT}/mingw64/libexec/git-core`;

interface FakeWindows {
  /** What is on PATH, by command name. */
  path?: Record<string, string>;
  /** Which absolute paths exist. */
  files?: string[];
  /** What `git --exec-path` answers. */
  execPath?: string | null;
  localAppData?: string | null;
}

function fakeWindows(options: FakeWindows = {}): ToolLookup {
  return {
    platform: "win32",
    which: (command) => options.path?.[command] ?? null,
    exists: (candidate) => (options.files ?? []).includes(candidate),
    gitExecPath: () => options.execPath ?? null,
    localAppData: options.localAppData ?? null,
  };
}

describe("resolveUnixTool on Linux and macOS", () => {
  test("is the PATH lookup, nothing more", () => {
    const lookup: ToolLookup = {
      platform: "linux",
      which: (command) => (command === "bash" ? "/usr/bin/bash" : null),
      exists: () => true,
      gitExecPath: () => GIT_EXEC_PATH,
      localAppData: null,
    };
    expect(resolveUnixTool("bash", lookup)).toBe("/usr/bin/bash");
    // No Git-for-Windows guessing off PATH, even though every candidate above "exists".
    expect(resolveUnixTool("7z", lookup)).toBeNull();
  });

  test("resolves this machine's own shell through the real lookup", () => {
    expect(resolveUnixTool("sh")).toContain("sh");
    expect(resolveUnixTool("libredb-not-a-binary-4b7c")).toBeNull();
  });
});

describe("resolveUnixTool on Windows", () => {
  test("refuses WSL's bash and takes the Git for Windows one instead", () => {
    // The trap this helper exists for: with WSL installed, `bash` resolves - to a Linux shell that
    // cannot stat the Win32 temp path every fixture hands it, so the script under test looks broken.
    const lookup = fakeWindows({
      path: { bash: "C:\\Windows\\System32\\bash.exe", git: `${GIT_ROOT}/cmd/git.exe` },
      execPath: GIT_EXEC_PATH,
      files: [`${GIT_ROOT}/bin/bash.exe`],
    });
    expect(resolveUnixTool("bash", lookup)).toBe(`${GIT_ROOT}/bin/bash.exe`);
  });

  test("keeps a System32 hit that WSL does not shadow", () => {
    // Windows 10+ ships a genuine bsdtar as System32\tar.exe; only the shells are shadowed.
    const lookup = fakeWindows({ path: { tar: "C:\\Windows\\System32\\tar.exe" } });
    expect(resolveUnixTool("tar", lookup)).toBe("C:\\Windows\\System32\\tar.exe");
  });

  test("keeps a shell that is genuinely on PATH (MSYS2, or a PATH that carries Git's usr/bin)", () => {
    const lookup = fakeWindows({ path: { sh: "C:\\msys64\\usr\\bin\\sh.exe" } });
    expect(resolveUnixTool("sh", lookup)).toBe("C:\\msys64\\usr\\bin\\sh.exe");
  });

  test("asks the git binary it found, rather than guessing the install location", () => {
    const asked: string[] = [];
    const lookup: ToolLookup = {
      platform: "win32",
      which: (command) => (command === "git" ? "D:/tools/PortableGit/cmd/git.exe" : null),
      exists: (candidate) => candidate === "D:/tools/PortableGit/usr/bin/grep.exe",
      gitExecPath: (gitBinary) => {
        asked.push(gitBinary);
        return "D:/tools/PortableGit/mingw64/libexec/git-core";
      },
      localAppData: null,
    };
    expect(resolveUnixTool("grep", lookup)).toBe("D:/tools/PortableGit/usr/bin/grep.exe");
    expect(asked).toEqual(["D:/tools/PortableGit/cmd/git.exe"]);
  });

  test("reads back the backslashes git prints when it prints them", () => {
    const lookup = fakeWindows({
      path: { git: `${GIT_ROOT}/cmd/git.exe` },
      execPath: "C:\\Program Files\\Git\\mingw64\\libexec\\git-core",
      files: [`${GIT_ROOT}/usr/bin/unzip.exe`],
    });
    expect(resolveUnixTool("unzip", lookup)).toBe(`${GIT_ROOT}/usr/bin/unzip.exe`);
  });

  test("falls back to a per-user install when git is not on PATH at all", () => {
    const home = "C:\\Users\\dev\\AppData\\Local";
    const lookup = fakeWindows({
      localAppData: home,
      files: ["C:/Users/dev/AppData/Local/Programs/Git/bin/bash.exe"],
    });
    expect(resolveUnixTool("bash", lookup)).toBe("C:/Users/dev/AppData/Local/Programs/Git/bin/bash.exe");
  });

  test("falls back to the standard install locations", () => {
    const lookup = fakeWindows({ files: ["C:/Program Files (x86)/Git/usr/bin/grep.exe"] });
    expect(resolveUnixTool("grep", lookup)).toBe("C:/Program Files (x86)/Git/usr/bin/grep.exe");
  });

  test("ignores a git that answers nothing, and a --exec-path with no ancestors to climb", () => {
    const silent = fakeWindows({ path: { git: "git.exe" }, execPath: null, files: [`${GIT_ROOT}/bin/sh.exe`] });
    expect(resolveUnixTool("sh", silent)).toBe(`${GIT_ROOT}/bin/sh.exe`);

    const truncated = fakeWindows({ path: { git: "git.exe" }, execPath: "git-core", files: [] });
    expect(resolveUnixTool("sh", truncated)).toBeNull();
  });

  test("answers null when the machine has no Git for Windows anywhere", () => {
    expect(resolveUnixTool("bash", fakeWindows())).toBeNull();
  });
});

describe("the real lookup", () => {
  test("finds a file that exists and not one that does not", () => {
    expect(systemLookup.exists(import.meta.path)).toBe(true);
    expect(systemLookup.exists(`${import.meta.path}.absent`)).toBe(false);
  });

  test("git answers --exec-path with a directory that exists", () => {
    // Every clone of this repository needed git, so an absent one is a broken machine, not a skip.
    const git = systemLookup.which("git");
    expect(git).not.toBeNull();
    const execPath = systemLookup.gitExecPath(git!);
    expect(execPath).not.toBeNull();
    expect(systemLookup.exists(execPath!)).toBe(true);
  });

  test("platform and LOCALAPPDATA are read from this process", () => {
    expect(systemLookup.platform).toBe(process.platform);
    expect(systemLookup.localAppData).toBe(process.env.LOCALAPPDATA ?? null);
  });
});

describe("the reasons a skip carries", () => {
  test("a resolvable shell has no reason at all", () => {
    expect(posixShell("sh")).not.toBeNull();
    expect(posixShell("bash")).not.toBeNull();
    expect(missingPosixShell("bash")).toBeNull();
    expect(missingUnixTool("git")).toBeNull();
  });

  test("an unresolvable one names what is missing and where it would have come from", () => {
    const none = fakeWindows();
    expect(posixShell("bash", none)).toBeNull();
    expect(missingPosixShell("sh", none)).toBe(
      "no POSIX sh: none on PATH and no Git for Windows installation carries one",
    );
    expect(missingUnixTool("7z", none)).toBe("no 7z: not on PATH and not in a Git for Windows installation");
  });

  test("POSIX file modes are a platform fact, not a probe", () => {
    // A probe could answer "no" on Linux (a noexec /tmp, a container quirk) and turn a genuine
    // regression into a skip; the platform cannot.
    expect(MISSING_POSIX_FILE_MODES).toBe(
      process.platform === "win32"
        ? "POSIX file modes: NTFS has no exec bit and Windows cannot exec an extension-less #! stub"
        : null,
    );
  });
});

/*
  The skip path, registered for real: a requirement no machine can meet, so the describe below is
  collected as skipped everywhere. The warnings are captured rather than printed because these two
  are self-tests and a reader scanning a green run should not have to decide whether they matter -
  every other caller's skip goes to the terminal.
*/
const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (message: string) => {
  warnings.push(message);
};
describeIf(missingUnixTool("libredb-not-a-binary-4b7c"), "describeIf's own skip path", () => {
  test("never runs, because the describe above is skipped", () => {
    throw new Error("a skipped describe must not execute its test bodies");
  });
});
// Both calls sit at module scope on purpose: bun defers a describe body, so a testIf inside one
// would log after the capture below is put back.
testIf(null, "testIf runs a test when nothing is missing", () => {
  expect(posixShell("sh")).not.toBeNull();
});
testIf(missingUnixTool("libredb-not-a-binary-4b7c"), "testIf's own skip path", () => {
  throw new Error("a skipped test must not execute its body");
});
console.warn = realWarn;

describe("a skipped requirement is visible", () => {
  test("names the title and the reason, in the title and in the log", () => {
    expect(warnings).toEqual([
      'posix-tools: skipping "describeIf\'s own skip path" - no libredb-not-a-binary-4b7c: ' +
        "not on PATH and not in a Git for Windows installation",
      'posix-tools: skipping "testIf\'s own skip path" - no libredb-not-a-binary-4b7c: ' +
        "not on PATH and not in a Git for Windows installation",
    ]);
  });
});

describeIfPosixShell("bash", "describeIfPosixShell", () => {
  test("runs the body on a machine that has bash", () => {
    expect(posixShell("bash")).not.toBeNull();
  });
});
