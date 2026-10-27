import assert from "node:assert/strict";
import { once } from "node:events";
import { ENABLED_PROVIDERS } from "../../src/host/channel";
import { type BackendSession, openSession } from "../backend-session";
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

/** Closes the channel and resolves the child's exit code, with the milliseconds it took. */
async function disconnect(session: BackendSession): Promise<{ code: number | null; ms: number }> {
  const started = Date.now();
  const exited = once(session.child, "exit");
  session.connection.dispose();
  session.child.disconnect();
  const [code] = (await exited) as [number | null];
  return { code, ms: Date.now() - started };
}

describe("the backend child", () => {
  let runtime: BackendRuntime;

  before(async () => {
    runtime = await backendRuntime();
  });

  it("answers initialize with the runtime it was forked on and the enabled providers", async () => {
    const session = openSession(forkBackend(runtime));
    const answer = await session.initialize();
    const { node, electron, modules } = answer.runtime;
    console.log(
      `${runtime.name}: ${runtime.execPath}, node ${node}, electron ${electron ?? "none"}, modules ${modules}`,
    );
    if (runtime.name === "vscode") {
      assert.match(electron ?? "", /^\d+\.\d+\.\d+$/);
      assert.match(node, /^24\./);
    } else {
      assert.equal(electron, null);
      assert.equal(node, process.versions.node);
    }
    assert.deepEqual(answer.enabledProviders, ENABLED_PROVIDERS);
    assert.equal((await disconnect(session)).code, 0);
  });

  it("exits 0 within 3 s once its host closes the channel", async () => {
    const session = openSession(forkBackend(runtime));
    await session.initialize();
    const { code, ms } = await disconnect(session);
    assert.equal(code, 0);
    assert.ok(ms < 3000, `the child took ${ms} ms to exit`);
  });
});
