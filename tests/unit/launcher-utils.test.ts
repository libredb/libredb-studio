/**
 * Unit tests for the npx launcher helpers (bin/lib/launcher-utils.mjs,
 * issue #110). Pure functions plus local-file hashing only - no network.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  artifactName,
  assertReleaseVersion,
  assessNodeRuntime,
  extractArchive,
  extractionCommand,
  LauncherUsageError,
  parseLauncherArgs,
  parseSha256Sums,
  preservePayloadData,
  releaseDownloadUrl,
  resolveCacheDir,
  sha256File,
} from "../../bin/lib/launcher-utils.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-utils-test-"));

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("artifactName", () => {
  test("maps every supported platform-arch pair to the release tarball name", () => {
    expect(artifactName("0.9.41", "linux", "x64")).toBe("libredb-studio-standalone-0.9.41-linux-x64.tar.gz");
    expect(artifactName("0.9.41", "linux", "arm64")).toBe("libredb-studio-standalone-0.9.41-linux-arm64.tar.gz");
    expect(artifactName("0.9.41", "darwin", "x64")).toBe("libredb-studio-standalone-0.9.41-darwin-x64.tar.gz");
    expect(artifactName("1.0.0", "darwin", "arm64")).toBe("libredb-studio-standalone-1.0.0-darwin-arm64.tar.gz");
  });

  test("maps win32-x64 to the release zip name (issue #114)", () => {
    // Windows ships a .zip (winget InstallerType zip; bsdtar-extractable),
    // not a .tar.gz - the extension is part of the artifact contract.
    expect(artifactName("0.9.41", "win32", "x64")).toBe("libredb-studio-standalone-0.9.41-win32-x64.zip");
  });

  test("throws for targets the release workflow does not build", () => {
    expect(() => artifactName("0.9.41", "win32", "arm64")).toThrow(/win32-arm64/);
    expect(() => artifactName("0.9.41", "linux", "ia32")).toThrow(/linux-ia32/);
    expect(() => artifactName("0.9.41", "freebsd", "arm64")).toThrow(/Supported targets/);
    expect(() => artifactName("0.9.41", "freebsd", "arm64")).toThrow(/win32-x64/);
  });
});

describe("extractionCommand", () => {
  test("builds the strip-one-root tar command for .tar.gz archives", () => {
    expect(extractionCommand("/tmp/payload.tar.gz", "/tmp/dest", "linux", {})).toEqual({
      command: "tar",
      args: ["-xzf", "/tmp/payload.tar.gz", "-C", "/tmp/dest", "--strip-components=1"],
    });
  });

  test("uses the System32 bsdtar for .zip archives on win32 (Git Bash GNU tar cannot read zip)", () => {
    // The win32 zip is flat (no versioned root - winget's RelativeFilePath
    // must stay stable across versions), so no --strip-components here.
    expect(extractionCommand("C:\\cache\\payload.zip", "C:\\cache\\dest", "win32", { SystemRoot: "D:\\Win" })).toEqual({
      command: "D:\\Win\\System32\\tar.exe",
      args: ["-xf", "C:\\cache\\payload.zip", "-C", "C:\\cache\\dest"],
    });
  });

  test("falls back to C:\\Windows when SystemRoot is unset", () => {
    expect(extractionCommand("a.zip", "dest", "win32", {}).command).toBe("C:\\Windows\\System32\\tar.exe");
  });

  test("uses plain tar for .zip archives on macOS (the system tar is bsdtar and reads zip natively)", () => {
    expect(extractionCommand("/tmp/payload.zip", "/tmp/dest", "darwin", {})).toEqual({
      command: "tar",
      args: ["-xf", "/tmp/payload.zip", "-C", "/tmp/dest"],
    });
  });

  test("refuses .zip archives on linux (GNU tar cannot read zip - fail loudly, not cryptically)", () => {
    expect(() => extractionCommand("/tmp/payload.zip", "/tmp/dest", "linux", {})).toThrow(
      /zip archives cannot be extracted on linux/,
    );
    expect(() => extractionCommand("/tmp/payload.zip", "/tmp/dest", "linux", {})).toThrow(/tar\.gz/);
  });

  test("is case-insensitive on the .zip extension", () => {
    expect(extractionCommand("/tmp/PAYLOAD.ZIP", "/tmp/dest", "darwin", {}).args[0]).toBe("-xf");
  });
});

describe("assertReleaseVersion", () => {
  test.each(["0.9.41", "1.0.0", "10.20.30", "1.0.0-rc.1", "0.9.42-beta"])("accepts plain semver %s", (version) => {
    expect(assertReleaseVersion(version)).toBe(version);
  });

  test.each([
    "v0.9.41",
    "../../evil/evil",
    "0.9.41/../../other",
    "0.9.41?download=1",
    "0.9.41#frag",
    "0.9",
    "0.9.41..",
    "",
  ])("rejects %j before it can reach a URL or cache path", (version) => {
    expect(() => assertReleaseVersion(version)).toThrow(/Invalid release version/);
  });

  test("rejects non-string versions from a corrupted manifest", () => {
    expect(() => assertReleaseVersion(undefined as unknown as string)).toThrow(/Invalid release version/);
  });

  test("guards the URL and cache-path builders", () => {
    expect(() => releaseDownloadUrl("../evil", "SHA256SUMS")).toThrow(/Invalid release version/);
    expect(() => resolveCacheDir("../evil", "/home/alice")).toThrow(/Invalid release version/);
    expect(() => artifactName("../evil", "linux", "x64")).toThrow(/Invalid release version/);
  });
});

describe("releaseDownloadUrl", () => {
  test("builds the GitHub release asset URL without a v prefix", () => {
    expect(releaseDownloadUrl("0.9.41", "SHA256SUMS")).toBe(
      "https://github.com/libredb/libredb-studio/releases/download/0.9.41/SHA256SUMS",
    );
  });
});

describe("resolveCacheDir", () => {
  test("resolves to <home>/.libredb-studio/<version>", () => {
    expect(resolveCacheDir("0.9.41", "/home/alice")).toBe(path.join("/home/alice", ".libredb-studio", "0.9.41"));
  });
});

describe("parseSha256Sums", () => {
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);

  test("parses sha256sum output into a name-to-digest map", () => {
    const sums = parseSha256Sums(
      `${digestA}  libredb-studio-standalone-0.9.41-linux-x64.tar.gz\n` +
        `${digestB}  libredb-studio-standalone-0.9.41-darwin-arm64.tar.gz\n`,
    );
    expect(sums.size).toBe(2);
    expect(sums.get("libredb-studio-standalone-0.9.41-linux-x64.tar.gz")).toBe(digestA);
    expect(sums.get("libredb-studio-standalone-0.9.41-darwin-arm64.tar.gz")).toBe(digestB);
  });

  test("accepts the binary marker and normalizes uppercase digests", () => {
    const sums = parseSha256Sums(`${"C".repeat(64)}  *archive.tar.gz\n`);
    expect(sums.get("archive.tar.gz")).toBe("c".repeat(64));
  });

  test("skips blank and malformed lines", () => {
    const sums = parseSha256Sums(`\nnot a sums line\n${"d".repeat(63)}  short-digest.tar.gz\n${digestA}  ok.tar.gz\n`);
    expect(sums.size).toBe(1);
    expect(sums.get("ok.tar.gz")).toBe(digestA);
  });
});

describe("sha256File", () => {
  test("computes the sha256 hex digest of a file", async () => {
    const filePath = path.join(tempDir, "hello.txt");
    fs.writeFileSync(filePath, "hello\n");
    // sha256 of "hello\n" (printf 'hello\n' | sha256sum)
    expect(await sha256File(filePath)).toBe("5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03");
  });

  test("rejects when the file does not exist", async () => {
    await expect(sha256File(path.join(tempDir, "missing.txt"))).rejects.toThrow();
  });
});

describe("parseLauncherArgs", () => {
  test("returns defaults for an empty argv", () => {
    expect(parseLauncherArgs([])).toEqual({
      help: false,
      port: null,
      host: null,
      archive: null,
      archiveSha256: null,
      verifyCache: false,
    });
  });

  test("parses --help and -h", () => {
    expect(parseLauncherArgs(["--help"]).help).toBe(true);
    expect(parseLauncherArgs(["-h"]).help).toBe(true);
  });

  test("parses --port with a separate or inline value", () => {
    expect(parseLauncherArgs(["--port", "3893"]).port).toBe(3893);
    expect(parseLauncherArgs(["--port=3893"]).port).toBe(3893);
  });

  test("parses --archive with a separate or inline value", () => {
    expect(parseLauncherArgs(["--archive", "/tmp/payload.tar.gz"]).archive).toBe("/tmp/payload.tar.gz");
    expect(parseLauncherArgs(["--archive=/tmp/payload.tar.gz"]).archive).toBe("/tmp/payload.tar.gz");
  });

  test("parses --host with a separate or inline value", () => {
    expect(parseLauncherArgs(["--host", "0.0.0.0"]).host).toBe("0.0.0.0");
    expect(parseLauncherArgs(["--host=::1"]).host).toBe("::1");
  });

  test("parses --verify-cache", () => {
    expect(parseLauncherArgs(["--verify-cache"]).verifyCache).toBe(true);
  });

  test("parses --archive-sha256 and lowercases the digest", () => {
    const digest = "A".repeat(64);
    expect(parseLauncherArgs(["--archive-sha256", digest]).archiveSha256).toBe("a".repeat(64));
  });

  test("rejects malformed --archive-sha256 digests", () => {
    for (const value of ["abc", "g".repeat(64), "a".repeat(63), ""]) {
      expect(() => parseLauncherArgs(["--archive-sha256", value])).toThrow(LauncherUsageError);
    }
    expect(() => parseLauncherArgs(["--archive-sha256"])).toThrow(LauncherUsageError);
  });

  test("parses combined flags", () => {
    expect(parseLauncherArgs(["--port", "3893", "--host", "0.0.0.0", "--archive", "/tmp/a.tar.gz"])).toEqual({
      help: false,
      port: 3893,
      host: "0.0.0.0",
      archive: "/tmp/a.tar.gz",
      archiveSha256: null,
      verifyCache: false,
    });
  });

  test("rejects invalid ports", () => {
    for (const value of ["abc", "0", "65536", "80.5", "-1"]) {
      expect(() => parseLauncherArgs(["--port", value])).toThrow(LauncherUsageError);
    }
  });

  test("rejects flags with missing values", () => {
    expect(() => parseLauncherArgs(["--port"])).toThrow(LauncherUsageError);
    expect(() => parseLauncherArgs(["--archive"])).toThrow(LauncherUsageError);
    expect(() => parseLauncherArgs(["--archive="])).toThrow(LauncherUsageError);
    expect(() => parseLauncherArgs(["--host"])).toThrow(LauncherUsageError);
    expect(() => parseLauncherArgs(["--host="])).toThrow(LauncherUsageError);
  });

  test("rejects unknown arguments", () => {
    expect(() => parseLauncherArgs(["--verbose"])).toThrow(LauncherUsageError);
    expect(() => parseLauncherArgs(["serve"])).toThrow(LauncherUsageError);
  });
});

describe("assessNodeRuntime", () => {
  test.each(["18.19.0", "20.0.0", "20.8.9"])("fails below the 20.9 floor (%s)", (version) => {
    const result = assessNodeRuntime(version);
    expect(result.action).toBe("fail");
    expect(result.message).toContain("requires Node.js 20.9 or newer");
    expect(result.message).toContain(version);
    expect(result.message).toContain("docker run");
  });

  test.each([
    "20.9.0",
    "20.19.5",
    "21.7.3",
    "22.0.0",
    "22.5.0",
    "22.12.0",
  ])("warns that all SQLite features are unavailable on %s (no unflagged node:sqlite)", (version) => {
    const result = assessNodeRuntime(version);
    expect(result.action).toBe("warn");
    expect(result.message).toContain("SQLite features are unavailable");
    expect(result.message).toContain("node:sqlite");
    expect(result.message).toContain("Node 24");
  });

  test.each([
    "22.13.0",
    "22.23.1",
    "23.4.0",
  ])("warns only about server-side SQLite storage on %s (node:sqlite present, better-sqlite3 ABI mismatch)", (version) => {
    const result = assessNodeRuntime(version);
    expect(result.action).toBe("warn");
    expect(result.message).toContain("STORAGE_PROVIDER=sqlite");
    expect(result.message).toContain("Node 24 ABI");
    expect(result.message).not.toContain("SQLite features are unavailable");
  });

  test.each(["24.0.0", "24.14.0", "25.1.0", "26.0.0"])("is silent on the fully supported %s", (version) => {
    const result = assessNodeRuntime(version);
    expect(result.action).toBe("ok");
    expect(result.message).toBeNull();
  });

  test("handles prerelease-style version strings by their numeric prefix", () => {
    expect(assessNodeRuntime("24.0.0-nightly202512").action).toBe("ok");
    expect(assessNodeRuntime("20.8.0-rc.1").action).toBe("fail");
  });

  test("fails loudly on an unparsable version string", () => {
    const result = assessNodeRuntime("weird");
    expect(result.action).toBe("fail");
    expect(result.message).toContain("could not parse");
  });

  test("fails closed on two-component version strings (process.versions.node is always three)", () => {
    expect(assessNodeRuntime("22.13").action).toBe("fail");
  });

  test("fail boundary matches the package.json engines floor (single source of truth)", () => {
    // MINIMUM_NODE in launcher-utils.mjs and engines.node in package.json
    // state the same floor in two places; this pins them together so bumping
    // one without the other fails a test instead of shipping a drift.
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const match = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(pkg.engines.node);
    expect(match).not.toBeNull();
    const [major, minor, patch] = [Number(match![1]), Number(match![2]), Number(match![3])];
    expect(assessNodeRuntime(`${major}.${minor}.${patch}`).action).not.toBe("fail");
    const justBelow = minor > 0 ? `${major}.${minor - 1}.999` : `${major - 1}.999.999`;
    expect(assessNodeRuntime(justBelow).action).toBe("fail");
  });
});

describe("preservePayloadData", () => {
  // Simulates bin/studio.js's extract(): tar always unpacks a fresh, empty
  // data/ dir (per scripts/build-standalone-payload.sh) into a staging
  // directory before it replaces the previous payload directory. Without
  // this helper that swap wipes payload/data - the generated
  // auth-bootstrap.json and any SQLite storage file (issue #132).
  function makeDirs() {
    const payloadDir = fs.mkdtempSync(path.join(tempDir, "payload-"));
    const staging = fs.mkdtempSync(path.join(tempDir, "staging-"));
    return { payloadDir, staging };
  }

  test("moves an existing payload/data over the freshly extracted (empty) staging data dir", () => {
    const { payloadDir, staging } = makeDirs();
    fs.mkdirSync(path.join(payloadDir, "data"));
    fs.writeFileSync(path.join(payloadDir, "data", "auth-bootstrap.json"), '{"password":"A"}');
    fs.mkdirSync(path.join(staging, "data")); // tarball's fresh, empty data/ dir

    preservePayloadData(payloadDir, staging);

    expect(fs.readFileSync(path.join(staging, "data", "auth-bootstrap.json"), "utf8")).toBe('{"password":"A"}');
    expect(fs.existsSync(path.join(payloadDir, "data"))).toBe(false);
  });

  test("preserves non-empty data dirs containing generated SQLite storage state too", () => {
    const { payloadDir, staging } = makeDirs();
    fs.mkdirSync(path.join(payloadDir, "data"));
    fs.writeFileSync(path.join(payloadDir, "data", "auth-bootstrap.json"), '{"password":"A"}');
    fs.writeFileSync(path.join(payloadDir, "data", "libredb-storage.db"), "binary-sqlite-bytes");
    fs.mkdirSync(path.join(staging, "data"));

    preservePayloadData(payloadDir, staging);

    expect(fs.readdirSync(path.join(staging, "data")).sort()).toEqual(["auth-bootstrap.json", "libredb-storage.db"]);
  });

  test("is a no-op on first extraction (no previous payload directory)", () => {
    const { payloadDir, staging } = makeDirs();
    fs.rmSync(payloadDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(staging, "data"));
    fs.writeFileSync(path.join(staging, "data", ".gitkeep"), "");

    expect(() => preservePayloadData(payloadDir, staging)).not.toThrow();
    expect(fs.readdirSync(path.join(staging, "data"))).toEqual([".gitkeep"]);
  });

  test("is a no-op when the previous payload has no data dir", () => {
    const { payloadDir, staging } = makeDirs();
    fs.mkdirSync(path.join(staging, "data"));
    fs.writeFileSync(path.join(staging, "data", ".gitkeep"), "");

    preservePayloadData(payloadDir, staging);

    expect(fs.readdirSync(path.join(staging, "data"))).toEqual([".gitkeep"]);
  });
});

describe("extractArchive", () => {
  // Release tarballs are packed with a top-level libredb-studio-<version>/
  // root (issue #133, scripts/lib/pack-standalone-tarball.sh) instead of a
  // tarbomb; extractArchive must strip that one path component so the
  // payload (server.js, etc.) lands directly in destDir, matching every
  // caller's expectation (e.g. `payloadDir/server.js`). Windows .zip
  // archives are flat by design (issue #114) and take the zip branch of
  // extractionCommand, covered above.
  function buildFixtureTarball(rootName: string): string {
    const sourceDir = fs.mkdtempSync(path.join(tempDir, "extract-src-"));
    const versionedRoot = path.join(sourceDir, rootName);
    fs.mkdirSync(path.join(versionedRoot, "nested"), { recursive: true });
    fs.writeFileSync(path.join(versionedRoot, "server.js"), "// stub server");
    fs.writeFileSync(path.join(versionedRoot, "nested", "file.txt"), "nested contents");

    const tarballPath = path.join(sourceDir, "fixture.tar.gz");
    const result = Bun.spawnSync(["tar", "-czf", tarballPath, "-C", sourceDir, rootName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(`failed to build fixture tarball: ${result.stderr.toString()}`);
    return tarballPath;
  }

  test("strips the top-level libredb-studio-<version>/ root so the payload lands directly in destDir", () => {
    const tarballPath = buildFixtureTarball("libredb-studio-9.9.9");
    const destDir = fs.mkdtempSync(path.join(tempDir, "extract-dest-"));

    const { status, error } = extractArchive(tarballPath, destDir);

    expect(error).toBeNull();
    expect(status).toBe(0);
    expect(fs.readFileSync(path.join(destDir, "server.js"), "utf8")).toBe("// stub server");
    expect(fs.readFileSync(path.join(destDir, "nested", "file.txt"), "utf8")).toBe("nested contents");
    expect(fs.existsSync(path.join(destDir, "libredb-studio-9.9.9"))).toBe(false);
  });
});
