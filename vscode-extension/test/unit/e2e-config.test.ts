import assert from "node:assert/strict";
import { join } from "node:path";
import configurations, { configurationsFor } from "../../.vscode-test.mjs";
import { COEXISTENCE_EXTENSIONS_DIR } from "../../scripts/coexistence-extensions.mjs";
import versions from "../vscode-versions.json";

const EXTENSION_ROOT = join(__dirname, "..", "..");
const MOCHA = { ui: "bdd", forbidOnly: true, failZero: true, timeout: 60000 };

describe(".vscode-test.mjs", () => {
  it("fails a build whose files match no test, and refuses a focused one", () => {
    assert.ok(configurations.length > 0);
    for (const { label, mocha } of configurations) {
      assert.equal(mocha.failZero, true, label);
      assert.equal(mocha.forbidOnly, true, label);
    }
  });

  it("runs the e2e files and the workspace files on each pinned build", () => {
    assert.deepEqual(
      configurationsFor({}),
      [versions.floor, versions.stable].flatMap((version) => [
        { label: `vscode-${version}`, version, files: "out/test/e2e/**/*.test.js", mocha: MOCHA },
        {
          label: `vscode-${version}-workspace`,
          version,
          files: "out/test/e2e-workspace/**/*.test.js",
          workspaceFolder: "test/e2e-workspace/fixture",
          mocha: MOCHA,
        },
      ]),
    );
  });

  it("runs the smoke files alone, with no workspace configuration, in the smoke subset", () => {
    assert.deepEqual(
      configurationsFor({ LIBREDB_E2E_SUBSET: "smoke" }),
      [versions.floor, versions.stable].map((version) => ({
        label: `vscode-${version}`,
        version,
        files: "out/test/e2e/smoke/**/*.test.js",
        mocha: MOCHA,
      })),
    );
  });

  it("runs the one build LIBREDB_VSCODE_VERSION names", () => {
    assert.deepEqual(
      configurationsFor({ LIBREDB_VSCODE_VERSION: "insiders" }).map(({ label }) => label),
      ["vscode-insiders", "vscode-insiders-workspace"],
    );
  });

  it("runs the coexistence files alone, with mssql's extensions directory, in the coexistence subset", () => {
    assert.deepEqual(
      configurationsFor({ LIBREDB_E2E_SUBSET: "coexistence" }),
      [versions.floor, versions.stable].map((version) => ({
        label: `vscode-${version}-coexistence`,
        version,
        files: "out/test/e2e-coexistence/**/*.test.js",
        launchArgs: [`--extensions-dir=${join(EXTENSION_ROOT, COEXISTENCE_EXTENSIONS_DIR)}`],
        mocha: MOCHA,
      })),
    );
    assert.deepEqual(
      configurationsFor({ LIBREDB_E2E_SUBSET: "coexistence", LIBREDB_VSCODE_VERSION: "insiders" }).map(
        ({ label }) => label,
      ),
      ["vscode-insiders-coexistence"],
    );
  });

  it("refuses a subset other than smoke and coexistence", () => {
    assert.throws(
      () => configurationsFor({ LIBREDB_E2E_SUBSET: "all" }),
      /^Error: LIBREDB_E2E_SUBSET is "all"; set it to smoke or coexistence, or leave it unset\.$/,
    );
  });
});
