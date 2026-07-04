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
  LauncherUsageError,
  parseLauncherArgs,
  parseSha256Sums,
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

  test("throws for targets the release workflow does not build", () => {
    expect(() => artifactName("0.9.41", "win32", "x64")).toThrow(/win32-x64/);
    expect(() => artifactName("0.9.41", "linux", "ia32")).toThrow(/linux-ia32/);
    expect(() => artifactName("0.9.41", "freebsd", "arm64")).toThrow(/Supported targets/);
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
