import assert from "node:assert/strict";
import { vscePublishArgs } from "../../../scripts/publish.mjs";

describe("vscePublishArgs", () => {
  it("publishes the tested VSIX as a pre-release on an odd minor, with GitHub's OIDC token", () => {
    assert.deepEqual(vscePublishArgs("0.1.1"), [
      "publish",
      "--oidc",
      "--packagePath",
      "dist-vsix/libredb-studio-0.1.1.vsix",
      "--pre-release",
    ]);
  });

  it("publishes a release on an even minor", () => {
    assert.deepEqual(vscePublishArgs("0.2.0"), [
      "publish",
      "--oidc",
      "--packagePath",
      "dist-vsix/libredb-studio-0.2.0.vsix",
    ]);
  });

  it("publishes the file vsce packed, so nothing is rebuilt for the upload", async () => {
    const { vscePackageArgs } = await import("../../../scripts/package.mjs");
    for (const version of ["0.1.1", "0.2.0"]) {
      assert.equal(vscePublishArgs(version)[3], vscePackageArgs(version)[3]);
    }
  });

  it("refuses a version that is not major.minor.patch, naming it", () => {
    assert.throws(() => vscePublishArgs("0.2.0-rc.1"), /"0\.2\.0-rc\.1"/);
  });
});
