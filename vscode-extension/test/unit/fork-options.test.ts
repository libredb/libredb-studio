import assert from "node:assert/strict";
import { ENABLED_PROVIDERS } from "../../src/host/channel";
import { backendForkOptions } from "../../src/host/fork-options";

describe("backendForkOptions", () => {
  it("forks the child as part 1 starts it, with no execPath of its own", () => {
    const options = backendForkOptions("/ext");
    assert.equal("execPath" in options, false);
    assert.deepEqual(options.execArgv, []);
    assert.equal(options.cwd, "/ext");
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe", "ipc"]);
    assert.equal(options.serialization, "json");
    assert.equal(options.windowsHide, true);
  });

  it("hands the child this process's environment, Node mode, production and the enabled providers", () => {
    const { env } = backendForkOptions("/ext");
    assert.ok(env);
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(env.ELECTRON_NO_ASAR, "1");
    assert.equal(env.NODE_ENV, "production");
    assert.equal(env.LIBREDB_ENABLED_PROVIDERS, ENABLED_PROVIDERS.join(","));
    assert.ok(!env.LIBREDB_ENABLED_PROVIDERS.split(",").includes("oracle"));
  });

  it("uses the execPath it is given", () => {
    assert.equal(backendForkOptions("/ext", "/vscode/code").execPath, "/vscode/code");
  });
});
