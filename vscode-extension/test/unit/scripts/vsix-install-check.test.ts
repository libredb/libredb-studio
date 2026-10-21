import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extensionId, installArgs, listArgs, listedVersion } from "../../../scripts/vsix-install-check.mjs";

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "package.json"), "utf8"));
const CLI = ["/v/bin/code", "--extensions-dir=/c/extensions", "--user-data-dir=/c/user-data"];
const DIRS = { extensions: "/t/e", userData: "/t/u" };

describe("vsix-install-check", () => {
  it("names the extension <publisher>.<name> from the manifest", () => {
    assert.equal(extensionId(manifest), `${manifest.publisher}.${manifest.name}`);
    assert.equal(extensionId(manifest), "libredb.libredb-studio");
  });

  it("installs into the scratch profile, never the shared .vscode-test/extensions", () => {
    assert.deepEqual(installArgs(CLI, ["/w/a.vsix"], DIRS), [
      "/v/bin/code",
      "--extensions-dir=/t/e",
      "--user-data-dir=/t/u",
      "--install-extension",
      "/w/a.vsix",
    ]);
  });

  it("puts one --install-extension before each extension it installs", () => {
    assert.deepEqual(installArgs(CLI, ["ms-mssql.mssql@1.46.0", "a.vsix"], DIRS).slice(3), [
      "--install-extension",
      "ms-mssql.mssql@1.46.0",
      "--install-extension",
      "a.vsix",
    ]);
  });

  it("lists the same scratch profile's extensions with their versions", () => {
    assert.deepEqual(listArgs(CLI, DIRS), [
      "/v/bin/code",
      "--extensions-dir=/t/e",
      "--user-data-dir=/t/u",
      "--list-extensions",
      "--show-versions",
    ]);
  });

  it("reads the version an id is listed at, and nothing for a missing id or one it only prefixes", () => {
    const listed = "vscode.sql@1.0.0\nlibredb.libredb-studio@0.1.0\n";
    assert.equal(listedVersion(listed, "libredb.libredb-studio"), "0.1.0");
    assert.equal(listedVersion("vscode.sql@1.0.0\n", "libredb.libredb-studio"), undefined);
    assert.equal(listedVersion("libredb.libredb-studio-x@1.0.0\n", "libredb.libredb-studio"), undefined);
  });
});
