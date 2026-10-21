import assert from "node:assert/strict";
import { vscePackageArgs } from "../../../scripts/package.mjs";

describe("vscePackageArgs", () => {
  it("packs a pre-release on an odd minor", () => {
    assert.deepEqual(vscePackageArgs("0.1.0"), [
      "package",
      "--no-dependencies",
      "--out",
      "dist-vsix/libredb-studio-0.1.0.vsix",
      "--pre-release",
    ]);
    assert.equal(vscePackageArgs("1.3.5").at(-1), "--pre-release");
  });

  it("packs a release on an even minor", () => {
    assert.deepEqual(vscePackageArgs("0.2.0"), [
      "package",
      "--no-dependencies",
      "--out",
      "dist-vsix/libredb-studio-0.2.0.vsix",
    ]);
  });

  it("refuses a version that is not major.minor.patch, naming it", () => {
    assert.throws(() => vscePackageArgs("0.1"), /"0\.1"/);
  });
});
