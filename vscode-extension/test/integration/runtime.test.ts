import assert from "node:assert/strict";
import { once } from "node:events";
import type { RuntimeAnswer } from "../../src/backend/start";
import { type BackendRuntime, backendRuntime, forkBackend, runtimeName } from "./runtime";

describe("LIBREDB_BACKEND_RUNTIME", () => {
  it("names node or vscode and nothing else", () => {
    assert.equal(runtimeName("node"), "node");
    assert.equal(runtimeName("vscode"), "vscode");
    assert.throws(() => runtimeName("bun"), { message: 'LIBREDB_BACKEND_RUNTIME is "bun"; set it to node or vscode.' });
    assert.throws(() => runtimeName(undefined), {
      message: 'LIBREDB_BACKEND_RUNTIME is "undefined"; set it to node or vscode.',
    });
  });
});

describe("the backend child", () => {
  let runtime: BackendRuntime;

  before(async () => {
    runtime = await backendRuntime();
  });

  it("answers the versions of the runtime it was forked on", async () => {
    const child = forkBackend(runtime);
    const [answer] = (await once(child, "message")) as [RuntimeAnswer];
    console.log(
      `${runtime.name}: ${runtime.execPath}, node ${answer.versions.node}, electron ${answer.versions.electron ?? "none"}`,
    );
    if (runtime.name === "vscode") {
      assert.match(answer.versions.electron ?? "", /^\d+\.\d+\.\d+$/);
      assert.match(answer.versions.node, /^24\./);
    } else {
      assert.equal(answer.versions.electron, undefined);
      assert.equal(answer.versions.node, process.versions.node);
    }
    child.disconnect();
    await once(child, "exit");
  });

  it("exits 0 within 3 s once its host closes the channel", async () => {
    const child = forkBackend(runtime);
    await once(child, "message");
    const started = Date.now();
    child.disconnect();
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 3000);
  });
});
