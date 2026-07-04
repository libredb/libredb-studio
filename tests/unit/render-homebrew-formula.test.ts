/**
 * Unit tests for the Homebrew formula renderer
 * (scripts/render-homebrew-formula.mjs, issue #111). Renders the real
 * template against a fixture SHA256SUMS - pure string work, no network.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { renderHomebrewFormula } from "../../scripts/render-homebrew-formula.mjs";

const TEMPLATE_PATH = path.join(__dirname, "../../packaging/homebrew/libredb-studio.rb.tmpl");
const template = fs.readFileSync(TEMPLATE_PATH, "utf8");

const VERSION = "0.9.41";
const DIGESTS = {
  "darwin-x64": "1".repeat(64),
  "darwin-arm64": "2".repeat(64),
  "linux-x64": "3".repeat(64),
  "linux-arm64": "4".repeat(64),
};

function fixtureSums(targets: Record<string, string> = DIGESTS, version = VERSION): string {
  return (
    Object.entries(targets)
      .map(([target, digest]) => `${digest}  libredb-studio-standalone-${version}-${target}.tar.gz`)
      .join("\n") + "\n"
  );
}

describe("renderHomebrewFormula", () => {
  test("fills the version and all four platform digests from SHA256SUMS", () => {
    const rendered = renderHomebrewFormula(template, fixtureSums(), VERSION);

    expect(rendered).toContain('version "0.9.41"');
    expect(rendered).toContain("class LibredbStudio < Formula");
    for (const [target, digest] of Object.entries(DIGESTS)) {
      expect(rendered).toContain(
        `url "https://github.com/libredb/libredb-studio/releases/download/${VERSION}/` +
          `libredb-studio-standalone-${VERSION}-${target}.tar.gz"`,
      );
      expect(rendered).toContain(`sha256 "${digest}"`);
    }
  });

  test("leaves no placeholder markers in the rendered formula", () => {
    const rendered = renderHomebrewFormula(template, fixtureSums(), VERSION);
    expect(rendered).not.toContain("{{");
    expect(rendered).not.toContain("}}");
  });

  test("ignores unrelated SHA256SUMS entries", () => {
    const sums = fixtureSums() + `${"e".repeat(64)}  libredb-studio_0.9.41_amd64.deb\n`;
    const rendered = renderHomebrewFormula(template, sums, VERSION);
    expect(rendered).not.toContain("e".repeat(64));
  });

  test("throws when a platform digest is missing", () => {
    const partial: Record<string, string> = { ...DIGESTS };
    delete partial["linux-arm64"];
    expect(() => renderHomebrewFormula(template, fixtureSums(partial), VERSION)).toThrow(
      /SHA256SUMS has no entry for libredb-studio-standalone-0\.9\.41-linux-arm64\.tar\.gz/,
    );
  });

  test("throws when the SHA256SUMS entries are for a different version", () => {
    expect(() => renderHomebrewFormula(template, fixtureSums(DIGESTS, "0.9.40"), VERSION)).toThrow(
      /SHA256SUMS has no entry/,
    );
  });

  test("rejects invalid or v-prefixed versions", () => {
    for (const version of ["v0.9.41", "0.9", "0.9.41; rm -rf /", ""]) {
      expect(() => renderHomebrewFormula(template, fixtureSums(), version)).toThrow(/not a valid semver/);
    }
  });

  test("throws when a placeholder survives rendering", () => {
    const brokenTemplate = template + "\n# stray {{NOT_A_KNOWN_PLACEHOLDER}}\n";
    expect(() => renderHomebrewFormula(brokenTemplate, fixtureSums(), VERSION)).toThrow(
      /Unfilled placeholder \{\{NOT_A_KNOWN_PLACEHOLDER\}\}/,
    );
  });
});
