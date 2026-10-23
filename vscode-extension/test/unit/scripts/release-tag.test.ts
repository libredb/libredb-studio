import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTagViolations, TAG_PREFIX } from "../../../scripts/release-tag.mjs";

const EXTENSION_ROOT = join(__dirname, "..", "..", "..");

describe("release-tag", () => {
  it("names the extension's own tag namespace, apart from the product's bare semver and the chart's", () => {
    assert.equal(TAG_PREFIX, "vscode-extension-");
  });

  it("lets the tag that names the manifest's version release it", () => {
    assert.deepEqual(releaseTagViolations("vscode-extension-0.1.0", "0.1.0"), []);
  });

  it("refuses a tag whose version is not the manifest's", () => {
    assert.deepEqual(releaseTagViolations("vscode-extension-0.1.1", "0.1.0"), [
      "The tag vscode-extension-0.1.1 names 0.1.1, but vscode-extension/package.json is at 0.1.0.",
    ]);
  });

  it("refuses a product tag and a chart tag", () => {
    assert.deepEqual(releaseTagViolations("0.1.0", "0.1.0"), [
      "The tag 0.1.0 is not in the vscode-extension- namespace.",
    ]);
    assert.deepEqual(releaseTagViolations("libredb-studio-0.1.0", "0.1.0"), [
      "The tag libredb-studio-0.1.0 is not in the vscode-extension- namespace.",
    ]);
  });

  it("refuses a tag whose version is not major.minor.patch", () => {
    assert.deepEqual(releaseTagViolations("vscode-extension-v0.1.0", "0.1.0"), [
      "The tag vscode-extension-v0.1.0 names v0.1.0, which is not major.minor.patch.",
    ]);
    assert.deepEqual(releaseTagViolations("vscode-extension-0.1", "0.1.0"), [
      "The tag vscode-extension-0.1 names 0.1, which is not major.minor.patch.",
    ]);
    assert.deepEqual(releaseTagViolations("vscode-extension-0.1.0-rc.1", "0.1.0-rc.1"), [
      "The tag vscode-extension-0.1.0-rc.1 names 0.1.0-rc.1, which is not major.minor.patch.",
    ]);
  });
});

describe("release-tag.mjs as a program", () => {
  let dir: string;

  beforeEach(() => {
    // A scratch copy of the extension: every script and a manifest at 0.1.0, but no node_modules, because the
    // release workflow's verify job runs the guard on a bare checkout with nothing installed.
    dir = mkdtempSync(join(tmpdir(), "libredb-release-tag-"));
    cpSync(join(EXTENSION_ROOT, "scripts"), join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "libredb-studio", version: "0.1.0" }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (tag: string) =>
    spawnSync(process.execPath, [join(dir, "scripts", "release-tag.mjs"), tag], { encoding: "utf8" });

  it("prints what the tag releases and exits 0", () => {
    const result = run("vscode-extension-0.1.0");
    assert.equal(result.stdout, "vscode-extension-0.1.0 releases 0.1.0.\n");
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
  });

  it("prints each violation and exits 1", () => {
    const result = run("vscode-extension-0.1.1");
    assert.equal(
      result.stderr,
      "The tag vscode-extension-0.1.1 names 0.1.1, but vscode-extension/package.json is at 0.1.0.\n",
    );
    assert.equal(result.stdout, "");
    assert.equal(result.status, 1);
  });

  it("refuses to run without a tag", () => {
    const result = spawnSync(process.execPath, [join(dir, "scripts", "release-tag.mjs")], { encoding: "utf8" });
    assert.equal(result.stderr, "Usage: node scripts/release-tag.mjs <tag>\n");
    assert.equal(result.status, 1);
  });
});
