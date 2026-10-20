import assert from "node:assert/strict";
import configurations from "../../.vscode-test.mjs";

describe(".vscode-test.mjs", () => {
  it("fails a build whose files match no test, and refuses a focused one", () => {
    assert.ok(configurations.length > 0);
    for (const { label, mocha } of configurations) {
      assert.equal(mocha.failZero, true, label);
      assert.equal(mocha.forbidOnly, true, label);
    }
  });
});
