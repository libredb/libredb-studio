import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LICENSE_ALLOWLIST, LICENSE_OVERRIDES, renderNotices, VENDORED_LICENSES } from "../../../scripts/notices.mjs";

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

  /** Writes node_modules/<manifest.name> with this exact manifest and the given files; answers its directory. */
  function addManifest(manifest: Record<string, unknown>, files: Record<string, string>): string {
    const dir = join(repo, "node_modules", String(manifest.name));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    return dir;
  }

  /** Writes third-party-licenses/<file> beside the extension's package.json. */
  function vendor(file: string, text: string): void {
    mkdirSync(join(wd, "third-party-licenses"), { recursive: true });
    writeFileSync(join(wd, "third-party-licenses", file), text);
  }

  const metafile = (...inputs: string[]) => ({ inputs: Object.fromEntries(inputs.map((path) => [path, {}])) });
  const notices = (name: string) => renderNotices([metafile(`../node_modules/${name}/index.js`)], wd);

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
      "Unlicense",
    ]);
  });

  it("vendors texts in third-party-licenses/ and holds one reviewed override, precond@0.2.3", () => {
    assert.equal(VENDORED_LICENSES, "third-party-licenses");
    assert.deepEqual(LICENSE_OVERRIDES, {
      "precond@0.2.3": {
        license: "MIT",
        stated:
          "README.md, License: free to use under the terms of the MIT license (http://mturcotte.mit-license.org/)",
      },
    });
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

  for (const license of ["GPL-3.0-only", "(GPL-3.0 OR LGPL-3.0)", "MIT AND BSD-3-Clause"]) {
    it(`refuses a package licensed ${license}, naming it and the value`, () => {
      addPackage("copyleft", license, { LICENSE: "text" });
      assert.throws(() => notices("copyleft"), {
        message: `copyleft@1.2.3 is licensed "${license}", which is not on LICENSE_ALLOWLIST in scripts/notices.mjs.`,
      });
    });
  }

  it("allows the Unlicense, a public-domain dedication", () => {
    addManifest({ name: "nacl", version: "0.14.5", license: "Unlicense" }, { LICENSE: "Free and unencumbered" });
    assert.ok(notices("nacl").includes("\nnacl@0.14.5 (Unlicense)\n"));
  });

  it("allows an OR expression with one alternative on the list, keeping the expression as written", () => {
    addManifest({ name: "dual", version: "1.0.0", license: "(MIT OR Apache-2.0)" }, { LICENSE: "Dual text" });
    assert.ok(notices("dual").includes("\ndual@1.0.0 ((MIT OR Apache-2.0))\n"));
  });

  it("reads npm's legacy licenses array when license is absent, its types in the title", () => {
    addManifest(
      { name: "legacy", version: "1.0.0", licenses: [{ type: "MIT", url: "https://example.test/mit" }] },
      { LICENSE: "Legacy text" },
    );
    assert.ok(notices("legacy").includes("\nlegacy@1.0.0 (MIT)\n"));
  });

  it("refuses a legacy licenses array with a type off the list, naming every type", () => {
    addManifest(
      { name: "legacy", version: "1.0.0", licenses: [{ type: "MIT" }, { type: "GPL-3.0" }] },
      { LICENSE: "x" },
    );
    assert.throws(() => notices("legacy"), {
      message: 'legacy@1.0.0 is licensed "MIT, GPL-3.0", which is not on LICENSE_ALLOWLIST in scripts/notices.mjs.',
    });
  });

  it("takes the text of a package with no licence file from third-party-licenses/<name>@<version>.txt", () => {
    addManifest({ name: "bare", version: "1.0.0", license: "MIT" }, { "README.md": "no licence here" });
    vendor("bare@1.0.0.txt", "Source: https://example.test/bare/LICENSE\n\nThe MIT License\n");
    assert.ok(
      notices("bare").includes(
        "\nthird-party-licenses/bare@1.0.0.txt:\n\nSource: https://example.test/bare/LICENSE\n\nThe MIT License\n",
      ),
    );
  });

  it("refuses a package with neither a licence file nor a vendored text, naming both places", () => {
    const dir = addManifest({ name: "bare", version: "1.0.0", license: "MIT" }, { "README.md": "no licence here" });
    assert.throws(() => notices("bare"), {
      message: `bare@1.0.0 has no LICENSE, LICENCE, NOTICE or COPYING file in ${dir}, and third-party-licenses/ holds no bare@1.0.0.txt.`,
    });
  });

  it("names a scoped package's vendored text with the scope's slash written __", () => {
    addManifest({ name: "@scope/bare", version: "1.0.0", license: "MIT" }, {});
    vendor("@scope__bare@1.0.0.txt", "Source: https://example.test/scope-bare/LICENSE\n\nScoped MIT text");
    assert.ok(notices("@scope/bare").includes("\nthird-party-licenses/@scope__bare@1.0.0.txt:\n\nSource: "));
  });

  it("refuses a vendored text whose first line is not its Source: URL", () => {
    addManifest({ name: "bare", version: "1.0.0", license: "MIT" }, {});
    vendor("bare@1.0.0.txt", "The MIT License\n");
    assert.throws(() => notices("bare"), {
      message:
        'third-party-licenses/bare@1.0.0.txt must start with a "Source: <URL>" line naming where its text was copied from.',
    });
  });

  it("takes the licence of a package whose package.json names none from LICENSE_OVERRIDES, by exact version", () => {
    addManifest({ name: "precond", version: "0.2.3" }, { "README.md": "MIT, by its README" });
    vendor(
      "precond@0.2.3.txt",
      "Source: https://example.test/precond/LICENSE\n\nCopyright (C) 2012 Mathieu Turcotte\n",
    );
    assert.ok(notices("precond").includes("\nprecond@0.2.3 (MIT)\n"));
    rmSync(join(repo, "node_modules", "precond"), { recursive: true });
    addManifest({ name: "precond", version: "0.2.4" }, { LICENSE: "text" });
    assert.throws(() => notices("precond"), {
      message: "precond@0.2.4 has no SPDX license string in its package.json (found undefined).",
    });
  });

  it("refuses a package whose license field is not a string, naming it", () => {
    addPackage("legacy", { type: "MIT" }, { LICENSE: "text" });
    assert.throws(() => renderNotices([metafile("../node_modules/legacy/index.js")], wd), /legacy@1\.2\.3/);
  });
});

describe("the committed third-party-licenses/", () => {
  it("holds the four reviewed texts, each starting with the GitHub URL it was copied from", () => {
    const dir = join(__dirname, "..", "..", "..", "third-party-licenses");
    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ["assert-plus@1.0.0.txt", "pg-types@2.2.0.txt", "pgpass@1.0.5.txt", "precond@0.2.3.txt"]);
    for (const file of files) {
      assert.match(readFileSync(join(dir, file), "utf8"), /^Source: https:\/\/github\.com\/\S+\n\n\S/, file);
    }
  });
});
