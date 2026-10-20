import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LICENSE_ALLOWLIST, renderNotices } from "../../../scripts/notices.mjs";

describe("renderNotices", () => {
  let repo: string;
  let wd: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "libredb-notices-"));
    wd = join(repo, "vscode-extension");
    mkdirSync(wd);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /** Writes node_modules/<name> under the repository with its manifest and the given files. */
  function addPackage(name: string, license: unknown, files: Record<string, string>, version = "1.2.3"): void {
    const dir = join(repo, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, license }));
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  }

  const metafile = (...inputs: string[]) => ({ inputs: Object.fromEntries(inputs.map((path) => [path, {}])) });

  it("allows the reviewed licences and nothing else", () => {
    assert.deepEqual(LICENSE_ALLOWLIST, [
      "MIT",
      "ISC",
      "0BSD",
      "BSD-2-Clause",
      "BSD-3-Clause",
      "Apache-2.0",
      "BlueOak-1.0.0",
      "CC0-1.0",
    ]);
  });

  it("records an MIT package with its LICENSE text", () => {
    addPackage("alpha", "MIT", { LICENSE: "Alpha MIT text" });
    const text = renderNotices([metafile("../node_modules/alpha/index.js")], wd);
    assert.ok(text.includes("alpha@1.2.3 (MIT)"), text);
    assert.ok(text.includes("Alpha MIT text"), text);
  });

  it("carries an Apache-2.0 package's NOTICE with its LICENSE", () => {
    addPackage("beta", "Apache-2.0", { LICENSE: "Beta Apache text", NOTICE: "Beta notice text" });
    const text = renderNotices([metafile("../node_modules/beta/index.js")], wd);
    assert.ok(text.includes("beta@1.2.3 (Apache-2.0)"), text);
    assert.ok(text.includes("Beta Apache text"), text);
    assert.ok(text.includes("Beta notice text"), text);
  });

  it("reads LICENCE.md and COPYING too", () => {
    addPackage("gamma", "ISC", { "LICENCE.md": "Gamma licence text", COPYING: "Gamma copying text" });
    const text = renderNotices([metafile("../node_modules/gamma/index.js")], wd);
    assert.ok(text.includes("Gamma licence text"), text);
    assert.ok(text.includes("Gamma copying text"), text);
  });

  it("lists a package once however many inputs it gave, packages by name, across metafiles", () => {
    addPackage("zeta", "MIT", { LICENSE: "Zeta text" });
    addPackage("@scope/eta", "MIT", { LICENSE: "Eta text" });
    const text = renderNotices(
      [
        metafile("../node_modules/zeta/a.js", "../node_modules/zeta/b.js", "../src/lib/types.ts"),
        metafile("../node_modules/zeta/c.js", "../node_modules/@scope/eta/index.js"),
      ],
      wd,
    );
    assert.equal(text.split("zeta@1.2.3 (MIT)").length, 2, text);
    assert.ok(text.indexOf("@scope/eta@1.2.3") < text.indexOf("zeta@1.2.3"), text);
  });

  it("says so when no package is bundled", () => {
    const text = renderNotices([metafile("src/host/extension.ts", "../src/lib/types.ts")], wd);
    assert.ok(text.endsWith("No third-party package is bundled.\n"), text);
  });

  it("refuses a package with no licence text, naming it", () => {
    addPackage("bare", "MIT", { "README.md": "no licence here" });
    assert.throws(() => renderNotices([metafile("../node_modules/bare/index.js")], wd), /bare@1\.2\.3/);
  });

  for (const license of ["GPL-3.0-only", "(MIT OR GPL-3.0-only)"]) {
    it(`refuses a package licensed ${license}, naming it and the value`, () => {
      addPackage("copyleft", license, { LICENSE: "text" });
      assert.throws(
        () => renderNotices([metafile("../node_modules/copyleft/index.js")], wd),
        (error: Error) => error.message.includes("copyleft@1.2.3") && error.message.includes(`"${license}"`),
      );
    });
  }

  it("refuses a package whose license field is not a string, naming it", () => {
    addPackage("legacy", { type: "MIT" }, { LICENSE: "text" });
    assert.throws(() => renderNotices([metafile("../node_modules/legacy/index.js")], wd), /legacy@1\.2\.3/);
  });
});
