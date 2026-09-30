/**
 * Unit tests for the AUR PKGBUILD renderer (scripts/render-aur-pkgbuild.mjs,
 * issue #971). Renders the real packaging/aur/PKGBUILD against a fixture
 * SHA256SUMS and fixture packaging/linux files - pure string and file work, no
 * network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINUX_SOURCE_FILES, renderAurPkgbuild } from "../../scripts/render-aur-pkgbuild.mjs";

const ROOT = join(import.meta.dir, "../..");
const SCRIPT = join(ROOT, "scripts/render-aur-pkgbuild.mjs");
const pkgbuild = readFileSync(join(ROOT, "packaging/aur/PKGBUILD"), "utf8");

const VERSION = "0.18.0";
const X64 = "a".repeat(64);
const ARM64 = "b".repeat(64);
const LINUX = { launcher: "1".repeat(64), service: "2".repeat(64), env: "3".repeat(64) };

function fixtureSums(version = VERSION, targets: Record<string, string> = { x64: X64, arm64: ARM64 }): string {
  return (
    Object.entries(targets)
      .map(([arch, digest]) => `${digest}  libredb-studio-standalone-${version}-linux-${arch}.tar.gz`)
      .join("\n") + `\n${"c".repeat(64)}  libredb-studio-standalone-${version}-darwin-arm64.tar.gz\n`
  );
}

describe("renderAurPkgbuild", () => {
  test("sets pkgver, resets pkgrel and fills all five digests", () => {
    const rendered = renderAurPkgbuild(pkgbuild.replace(/^pkgrel=.*$/m, "pkgrel=3"), fixtureSums(), VERSION, LINUX);
    expect(rendered).toMatch(/^pkgver=0\.18\.0$/m);
    expect(rendered).toMatch(/^pkgrel=1$/m);
    expect(rendered).toContain(
      `sha256sums=('${LINUX.launcher}'\n            '${LINUX.service}'\n            '${LINUX.env}')`,
    );
    expect(rendered).toContain(`sha256sums_x86_64=('${X64}')`);
    expect(rendered).toContain(`sha256sums_aarch64=('${ARM64}')`);
  });

  test("changes nothing but the version and digest fields", () => {
    const rendered = renderAurPkgbuild(pkgbuild, fixtureSums(), VERSION, LINUX);
    const strip = (text: string) =>
      text
        .replace(/^pkgver=.*$/m, "")
        .replace(/^pkgrel=.*$/m, "")
        .replace(/^sha256sums(?:_x86_64|_aarch64)?=\([^)]*\)/gm, "");
    expect(strip(rendered)).toBe(strip(pkgbuild));
  });

  test("the digest order follows the order of source=() in the real PKGBUILD", () => {
    const source = /^source=\(([^)]*)\)/m.exec(pkgbuild)?.[1] ?? "";
    const targets = [...source.matchAll(/\$_raw\/([^"]+)"/g)].map((m) => m[1]);
    expect(targets).toEqual(LINUX_SOURCE_FILES.map((file: { name: string }) => file.name));
  });

  test("throws when SHA256SUMS lacks a linux tarball", () => {
    expect(() => renderAurPkgbuild(pkgbuild, fixtureSums(VERSION, { x64: X64 }), VERSION, LINUX)).toThrow(
      /linux-arm64/,
    );
  });

  test("throws on a prerelease version, because pkgver cannot hold a hyphen", () => {
    expect(() => renderAurPkgbuild(pkgbuild, fixtureSums("0.18.0-rc.1"), "0.18.0-rc.1", LINUX)).toThrow(/pkgver/);
  });

  test("throws on a version that is not semver", () => {
    expect(() => renderAurPkgbuild(pkgbuild, fixtureSums(), "v0.18.0", LINUX)).toThrow(/semver/);
  });

  test("throws when a field it must rewrite is missing", () => {
    const broken = pkgbuild.replace(/^sha256sums_aarch64=\([^)]*\)\n/m, "");
    expect(() => renderAurPkgbuild(broken, fixtureSums(), VERSION, LINUX)).toThrow(/sha256sums_aarch64/);
  });

  test("throws when a packaging/linux digest is not a sha256", () => {
    expect(() => renderAurPkgbuild(pkgbuild, fixtureSums(), VERSION, { ...LINUX, env: "abc" })).toThrow(/env/);
  });
});

describe("CLI", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("hashes the packaging/linux files it is given and writes the rendered PKGBUILD", () => {
    const dir = mkdtempSync(join(tmpdir(), "aur-render-"));
    dirs.push(dir);
    const linuxDir = join(dir, "linux");
    mkdirSync(linuxDir);
    const contents: Record<string, string> = {};
    for (const file of LINUX_SOURCE_FILES) {
      contents[file.name] = `fixture ${file.name}\n`;
      writeFileSync(join(linuxDir, file.name), contents[file.name]);
    }
    writeFileSync(join(dir, "SHA256SUMS"), fixtureSums());
    const out = join(dir, "out/PKGBUILD");

    const result = Bun.spawnSync(
      ["node", SCRIPT, join(ROOT, "packaging/aur/PKGBUILD"), join(dir, "SHA256SUMS"), VERSION, linuxDir, out],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    const rendered = readFileSync(out, "utf8");
    for (const file of LINUX_SOURCE_FILES) {
      expect(rendered).toContain(createHash("sha256").update(contents[file.name]).digest("hex"));
    }
    expect(rendered).toMatch(/^pkgver=0\.18\.0$/m);
  });

  test("exits 1 with usage when an argument is missing", () => {
    const result = Bun.spawnSync(["node", SCRIPT, "PKGBUILD"], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Usage");
  });
});
