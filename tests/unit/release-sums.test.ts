/**
 * Unit tests for the release checksum rebuild
 * (scripts/release-sums.mjs, issue #913).
 *
 * Why a test for this one: SHA256SUMS is what a user checks a downloaded
 * artifact against, and it is rebuilt on a draft release that is about to
 * become immutable - a file that silently drops or changes an entry would be
 * permanent and would invalidate the checksums the npx launcher, the Homebrew
 * formula and the Chocolatey/winget renderers are already pinned to. The
 * no-network paths and the superset assertion are what keep that from
 * happening; the CLI is exercised as a child process in the last block so the
 * argument handling and the exit codes are covered too.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertSuperset,
  assetSha256,
  buildSums,
  formatSum,
  hashResponse,
  hashUrl,
  isPayloadAsset,
  parseSums,
  payloadAssets,
} from "../../scripts/release-sums.mjs";

const SCRIPT = path.join(__dirname, "../../scripts/release-sums.mjs");
const VERSION = "0.16.0";
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

function asset(name: string, digest: string | null = HEX_A, url = `https://example.test/${name}`) {
  return { name, digest: digest === null ? null : `sha256:${digest}`, browser_download_url: url };
}

/** A release asset list shaped like `gh api releases/tags/<tag>`. */
function releaseFixture() {
  const assets = [
    asset(`libredb-studio-standalone-${VERSION}-linux-x64.tar.gz`),
    asset(`libredb-studio-standalone-${VERSION}-win32-x64.zip`),
    asset(`libredb-studio_${VERSION}_amd64.deb`),
    asset(`libredb-studio_${VERSION}_amd64.deb.sha256`),
    asset(`libredb-studio_${VERSION}_amd64.snap`),
    asset(`libredb-studio-${VERSION}.cdx.json`),
    asset("SHA256SUMS"),
  ];
  return { tag_name: VERSION, assets };
}

describe("payload asset selection", () => {
  test("treats everything except SHA256SUMS and the .sha256 sidecars as payload", () => {
    expect(isPayloadAsset("libredb-studio_0.16.0_amd64.snap")).toBe(true);
    expect(isPayloadAsset("libredb-studio-0.16.0.cdx.json")).toBe(true);
    expect(isPayloadAsset("libredb-studio_0.16.0_amd64.deb.sha256")).toBe(false);
    expect(isPayloadAsset("SHA256SUMS")).toBe(false);
  });

  test("sorts by name, which is the order the publish job's glob already produced", () => {
    const names = payloadAssets([
      asset(`libredb-studio-standalone-${VERSION}-win32-x64.zip`),
      asset(`libredb-studio-standalone-${VERSION}-darwin-arm64.tar.gz`),
      asset("SHA256SUMS"),
    ]).map((a) => a.name);

    expect(names).toEqual([
      `libredb-studio-standalone-${VERSION}-darwin-arm64.tar.gz`,
      `libredb-studio-standalone-${VERSION}-win32-x64.zip`,
    ]);
  });

  test("refuses a list that carries the same asset twice", () => {
    expect(() => payloadAssets([asset("a.snap"), asset("a.snap")])).toThrow(/twice/);
  });
});

describe("assetSha256", () => {
  test("reads the digest the API records", () => {
    expect(assetSha256(asset("a.snap", HEX_B))).toBe(HEX_B);
  });

  test("returns null when there is no usable digest", () => {
    expect(assetSha256(asset("a.snap", null))).toBeNull();
    expect(assetSha256({ name: "a.snap" })).toBeNull();
    expect(assetSha256({ name: "a.snap", digest: HEX_A })).toBeNull(); // no sha256: prefix
    expect(assetSha256({ name: "a.snap", digest: "sha256:not-hex" })).toBeNull();
    expect(assetSha256({ name: "a.snap", digest: `sha256:${"a".repeat(63)}` })).toBeNull();
    expect(assetSha256(undefined)).toBeNull();
  });
});

describe("buildSums", () => {
  test("covers every payload asset and leaves the sidecars out", async () => {
    const sums = await buildSums(releaseFixture().assets);

    // The three assets that had no checksum of any kind before issue #913.
    expect(sums).toContain(`${HEX_A}  libredb-studio_${VERSION}_amd64.snap\n`);
    expect(sums).toContain(`${HEX_A}  libredb-studio-${VERSION}.cdx.json\n`);
    expect(sums).toContain(`${HEX_A}  libredb-studio_${VERSION}_amd64.deb\n`);
    expect(sums).not.toContain(".sha256\n");
    expect(sums).not.toContain("SHA256SUMS");
    expect(sums.endsWith("\n")).toBe(true);
  });

  test("emits sha256sum's exact line format, sorted, and nothing else", async () => {
    const sums = await buildSums(releaseFixture().assets);
    const lines = sums.trimEnd().split("\n");

    expect(lines).toEqual([...lines].sort());
    for (const line of lines) {
      expect(line).toMatch(/^[0-9a-f]{64} {2}[^/]+$/);
    }
    expect(lines.length).toBe(5);
  });

  test("hashes locally when an asset has no digest and downloads are allowed", async () => {
    const body = "snap payload";
    const sums = await buildSums([asset("a.snap", null)], {
      allowDownload: true,
      fetchImpl: async () => new Response(body),
    });

    expect(sums).toBe(`${crypto.createHash("sha256").update(body).digest("hex")}  a.snap\n`);
  });

  test("refuses to hash locally unless --allow-download was given", async () => {
    await expect(buildSums([asset("a.snap", null)])).rejects.toThrow(
      /'a\.snap' has no sha256 digest recorded - re-run with --allow-download/,
    );
  });

  test("rejects an asset that has neither a digest nor a download URL", async () => {
    await expect(buildSums([{ name: "a.snap" }], { allowDownload: true })).rejects.toThrow(
      /no digest and no download URL/,
    );
  });

  test("rejects an empty payload set rather than writing an empty file", async () => {
    await expect(buildSums([asset("SHA256SUMS")])).rejects.toThrow(/no payload assets/);
  });
});

describe("hashResponse / hashUrl", () => {
  test("hashes a downloaded asset", async () => {
    expect(await hashResponse(new Response("payload"))).toBe(
      crypto.createHash("sha256").update("payload").digest("hex"),
    );
  });

  test("fails on a non-2xx download instead of hashing an error page", async () => {
    await expect(hashResponse(new Response("nope", { status: 404 }))).rejects.toThrow(/HTTP 404/);
  });

  test("fetches the asset's own URL", async () => {
    let requested: string | undefined;
    const hash = await hashUrl("https://example.test/a.snap", async (url) => {
      requested = url;
      return new Response("payload");
    });

    expect(requested).toBe("https://example.test/a.snap");
    expect(hash).toBe(crypto.createHash("sha256").update("payload").digest("hex"));
  });
});

describe("assertSuperset", () => {
  const before = `${HEX_A}  libredb-studio-standalone-${VERSION}-linux-x64.tar.gz\n`;

  test("accepts a widened file", () => {
    expect(() => assertSuperset(before, before + `${HEX_B}  libredb-studio_${VERSION}_amd64.snap\n`)).not.toThrow();
  });

  test("rejects a dropped entry", () => {
    expect(() => assertSuperset(before, `${HEX_B}  other.snap\n`)).toThrow(/dropped the existing entry/);
  });

  test("rejects a changed hash for an entry that is still listed", () => {
    expect(() => assertSuperset(before, `${HEX_B}  libredb-studio-standalone-${VERSION}-linux-x64.tar.gz\n`)).toThrow(
      /changed the hash for 'libredb-studio-standalone-0\.16\.0-linux-x64\.tar\.gz'/,
    );
  });
});

describe("parseSums", () => {
  test("reads entries and skips blank lines", () => {
    const entries = parseSums(`${HEX_A}  a.tar.gz\n\n${HEX_B}  b.snap\n`);

    expect(entries.get("a.tar.gz")).toBe(HEX_A);
    expect(entries.get("b.snap")).toBe(HEX_B);
    expect(entries.size).toBe(2);
    expect(parseSums(undefined).size).toBe(0);
  });

  test("rejects a line it cannot read rather than ignoring it", () => {
    expect(() => parseSums("not a checksum line\n")).toThrow(/Malformed SHA256SUMS line/);
  });

  test("formats a line the way sha256sum does", () => {
    expect(formatSum(HEX_A, "a.snap")).toBe(`${HEX_A}  a.snap\n`);
  });
});

describe("the CLI", () => {
  function run(args: string[]) {
    return spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
  }

  function fixtureDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-sums-"));
    const releasePath = path.join(dir, "release.json");
    fs.writeFileSync(releasePath, JSON.stringify(releaseFixture()));
    const existingPath = path.join(dir, "SHA256SUMS");
    fs.writeFileSync(
      existingPath,
      `${HEX_A}  libredb-studio-standalone-${VERSION}-linux-x64.tar.gz\n` +
        `${HEX_A}  libredb-studio-standalone-${VERSION}-win32-x64.zip\n`,
    );
    return { dir, releasePath, existingPath };
  }

  test("rebuilds the file and keeps the entries it already carried", () => {
    const { releasePath, existingPath } = fixtureDir();
    const result = run([releasePath, "--existing", existingPath]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${HEX_A}  libredb-studio_${VERSION}_amd64.snap\n`);
    expect(result.stderr).toContain("Rebuilt SHA256SUMS over 5 payload assets");
  });

  test("fails when an entry the release already carried would change", () => {
    const { releasePath, existingPath } = fixtureDir();
    fs.writeFileSync(existingPath, `${HEX_B}  libredb-studio-${VERSION}.cdx.json\n`);
    const result = run([releasePath, "--existing", existingPath]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("changed the hash for 'libredb-studio-0.16.0.cdx.json'");
  });

  test("fails on a missing digest rather than writing a partial file", () => {
    const { dir, releasePath } = fixtureDir();
    const release = JSON.parse(fs.readFileSync(releasePath, "utf8"));
    release.assets[0].digest = null;
    fs.writeFileSync(releasePath, JSON.stringify(release));
    const result = run([releasePath]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`'${release.assets[0].name}' has no sha256 digest recorded`);
    expect(fs.readdirSync(dir).sort()).toEqual(["SHA256SUMS", "release.json"]);
  });

  test("prints the usage line when the release document is missing", () => {
    const result = run([]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: node scripts/release-sums.mjs <release.json>");
  });

  test("rejects an --existing flag with no path, an unknown flag and a stray argument", () => {
    const { releasePath } = fixtureDir();

    expect(run([releasePath, "--existing"]).stderr).toContain("--existing needs a path");
    expect(run([releasePath, "--nope"]).stderr).toContain("Unknown argument: --nope");
    expect(run([releasePath, "extra.json"]).stderr).toContain("Unexpected argument: extra.json");
  });

  test("accepts --allow-download", () => {
    const { releasePath } = fixtureDir();
    const result = run([releasePath, "--allow-download"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Rebuilt SHA256SUMS over 5 payload assets");
  });
});
