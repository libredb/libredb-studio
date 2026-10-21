import assert from "node:assert/strict";
import {
  COEXISTENCE_EXTENSIONS,
  COEXISTENCE_EXTENSIONS_DIR,
  coexistenceBuilds,
  listingViolations,
} from "../../../scripts/coexistence-extensions.mjs";
import versions from "../../vscode-versions.json";

describe("coexistence-extensions", () => {
  it("pins every extension the coexistence leg installs to one version", () => {
    assert.ok(COEXISTENCE_EXTENSIONS.length > 0);
    for (const extension of COEXISTENCE_EXTENSIONS) assert.match(extension, /^[\w-]+\.[\w-]+@\d+\.\d+\.\d+$/);
    assert.deepEqual(COEXISTENCE_EXTENSIONS, [
      "ms-dotnettools.vscode-dotnet-runtime@3.2.0",
      "ms-mssql.data-workspace-vscode@0.7.0",
      "ms-mssql.sql-bindings-vscode@0.4.1",
      "ms-mssql.sql-database-projects-vscode@1.8.0",
      "ms-mssql.mssql@1.46.0",
    ]);
  });

  it("finds nothing wrong when the directory lists exactly the pinned set", () => {
    const listed = `${COEXISTENCE_EXTENSIONS.join("\n")}\n`;
    assert.deepEqual(listingViolations(listed, COEXISTENCE_EXTENSIONS), []);
  });

  it("names an extension listed at another version than its pin, one missing, and one nobody pinned", () => {
    const pins = ["ms-mssql.mssql@1.46.0", "ms-mssql.sql-bindings-vscode@0.4.1"];
    const listed = ["ms-mssql.mssql@1.47.0", "ms-mssql.data-workspace-vscode@0.8.0", ""].join("\r\n");
    assert.deepEqual(listingViolations(listed, pins), [
      "ms-mssql.mssql is listed at 1.47.0, pinned at 1.46.0",
      "ms-mssql.sql-bindings-vscode is not listed, pinned at 0.4.1",
      "ms-mssql.data-workspace-vscode@0.8.0 is listed but not pinned",
    ]);
  });

  it("installs them under .vscode-test/, never into the extensions directory every other e2e host loads", () => {
    assert.match(COEXISTENCE_EXTENSIONS_DIR, /^\.vscode-test\/[^/]+$/);
    assert.notEqual(COEXISTENCE_EXTENSIONS_DIR, ".vscode-test/extensions");
  });

  it("installs for the floor and stable builds in the coexistence subset only", () => {
    assert.deepEqual(coexistenceBuilds({ LIBREDB_E2E_SUBSET: "coexistence" }, versions), [
      versions.floor,
      versions.stable,
    ]);
    assert.deepEqual(coexistenceBuilds({}, versions), []);
    assert.deepEqual(coexistenceBuilds({ LIBREDB_E2E_SUBSET: "smoke" }, versions), []);
  });

  it("installs for the one build LIBREDB_VSCODE_VERSION names", () => {
    assert.deepEqual(
      coexistenceBuilds({ LIBREDB_E2E_SUBSET: "coexistence", LIBREDB_VSCODE_VERSION: "insiders" }, versions),
      ["insiders"],
    );
  });
});
