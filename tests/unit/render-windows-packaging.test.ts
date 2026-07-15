/**
 * Unit tests for the Windows packaging template renderer
 * (scripts/render-windows-packaging.mjs, issue #114). Renders the real
 * winget and Chocolatey templates against a fixture SHA256SUMS - pure
 * string work, no network (mirrors render-homebrew-formula.test.ts).
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { renderWindowsPackagingTemplate } from "../../scripts/render-windows-packaging.mjs";

const VERSION = "0.9.41";
const ZIP_DIGEST = "a".repeat(64);

const TEMPLATES = [
  "packaging/winget/LibreDB.Studio.yaml.tmpl",
  "packaging/winget/LibreDB.Studio.installer.yaml.tmpl",
  "packaging/winget/LibreDB.Studio.locale.en-US.yaml.tmpl",
  "packaging/chocolatey/libredb-studio.nuspec.tmpl",
  "packaging/chocolatey/tools/chocolateyinstall.ps1.tmpl",
].map((relative) => path.join(__dirname, "../..", relative));

function readTemplate(templatePath: string): string {
  return fs.readFileSync(templatePath, "utf8");
}

function fixtureSums(version = VERSION, digest = ZIP_DIGEST): string {
  return (
    `${"1".repeat(64)}  libredb-studio-standalone-${version}-linux-x64.tar.gz\n` +
    `${digest}  libredb-studio-standalone-${version}-win32-x64.zip\n`
  );
}

describe("renderWindowsPackagingTemplate", () => {
  test("fills the version and win32 zip digest", () => {
    const rendered = renderWindowsPackagingTemplate(
      "id {{VERSION}} sha {{SHA256_WIN32_X64}} again {{VERSION}}",
      fixtureSums(),
      VERSION,
    );
    expect(rendered).toBe(`id ${VERSION} sha ${ZIP_DIGEST} again ${VERSION}`);
  });

  test.each(TEMPLATES)("renders %s without leftover placeholders", (templatePath) => {
    const rendered = renderWindowsPackagingTemplate(readTemplate(templatePath), fixtureSums(), VERSION);
    expect(rendered).not.toContain("{{");
    expect(rendered).not.toContain("}}");
    expect(rendered).toContain(VERSION);
  });

  test("the winget installer manifest carries the release zip URL and digest", () => {
    const template = readTemplate(TEMPLATES[1]);
    const rendered = renderWindowsPackagingTemplate(template, fixtureSums(), VERSION);
    expect(rendered).toContain(
      `https://github.com/libredb/libredb-studio/releases/download/${VERSION}/` +
        `libredb-studio-standalone-${VERSION}-win32-x64.zip`,
    );
    expect(rendered).toContain(`InstallerSha256: ${ZIP_DIGEST}`);
    expect(rendered).toContain("RelativeFilePath: libredb-studio.exe");
  });

  test("the Chocolatey install script pins the checksum", () => {
    const template = readTemplate(TEMPLATES[4]);
    const rendered = renderWindowsPackagingTemplate(template, fixtureSums(), VERSION);
    expect(rendered).toContain(ZIP_DIGEST);
    expect(rendered).toContain("sha256");
  });

  test("throws when the win32 zip digest is missing from SHA256SUMS", () => {
    const sums = `${"1".repeat(64)}  libredb-studio-standalone-${VERSION}-linux-x64.tar.gz\n`;
    expect(() => renderWindowsPackagingTemplate("{{SHA256_WIN32_X64}}", sums, VERSION)).toThrow(
      /SHA256SUMS has no entry for libredb-studio-standalone-0\.9\.41-win32-x64\.zip/,
    );
  });

  test("throws when the SHA256SUMS entries are for a different version", () => {
    expect(() => renderWindowsPackagingTemplate("{{SHA256_WIN32_X64}}", fixtureSums("0.9.40"), VERSION)).toThrow(
      /SHA256SUMS has no entry/,
    );
  });

  test("rejects invalid or v-prefixed versions", () => {
    for (const version of ["v0.9.41", "0.9", "0.9.41; rm -rf /", ""]) {
      expect(() => renderWindowsPackagingTemplate("{{VERSION}}", fixtureSums(), version)).toThrow(/not a valid semver/);
    }
  });

  test("throws when a placeholder survives rendering", () => {
    expect(() =>
      renderWindowsPackagingTemplate("{{VERSION}} {{NOT_A_KNOWN_PLACEHOLDER}}", fixtureSums(), VERSION),
    ).toThrow(/Unfilled placeholder \{\{NOT_A_KNOWN_PLACEHOLDER\}\}/);
  });

  test("throws on a stray opening marker without a closing brace", () => {
    expect(() => renderWindowsPackagingTemplate("{{VERSION}} stray {{", fixtureSums(), VERSION)).toThrow(
      /Unfilled placeholder/,
    );
  });

  test("throws on a stray closing marker (a typoed {VERSION}} must fail closed, not ship)", () => {
    expect(() => renderWindowsPackagingTemplate("{VERSION}} stray", fixtureSums(), VERSION)).toThrow(
      /Unfilled placeholder/,
    );
    expect(() => renderWindowsPackagingTemplate("{{VERSION}} tail }}", fixtureSums(), VERSION)).toThrow(
      /Unfilled placeholder/,
    );
  });
});
