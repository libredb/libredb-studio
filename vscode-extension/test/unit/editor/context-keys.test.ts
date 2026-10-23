import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { BindingStore } from "../../../src/host/editor/bindings";
import { ContextKeys } from "../../../src/host/editor/context-keys";
import { RunRegistry } from "../../../src/host/editor/run-registry";
import { CONTEXT_KEYS } from "../../../src/host/names";
import { CancellationTokenSource } from "../../fakes/vscode";

/** One store of each kind, the publisher on them, every setContext call, and the warn lines. */
function publisher(reject: (key: string) => boolean = () => false) {
  const bindings = new BindingStore();
  const runs = new RunRegistry(() => new CancellationTokenSource());
  const published: [string, readonly string[]][] = [];
  const warnings: string[] = [];
  const keys = new ContextKeys({
    bindings,
    runs,
    setContext: (key, value) => {
      published.push([key, value]);
      return reject(key) ? Promise.reject(new Error("the host is gone")) : Promise.resolve();
    },
    log: { warn: (message: string) => warnings.push(message) },
  });
  return { bindings, runs, published, warnings, keys };
}

describe("ContextKeys", () => {
  it("names the three keys of part 3's table", () => {
    assert.deepEqual(CONTEXT_KEYS, {
      boundDocuments: "libredb.boundDocuments",
      runningQueries: "libredb.runningQueries",
      cancellableQueries: "libredb.cancellableQueries",
    });
  });

  it("publishes all three keys empty once, after one microtask", async () => {
    const { published } = publisher();
    assert.deepEqual(published, []);
    await Promise.resolve();
    assert.deepEqual(published, [
      ["libredb.boundDocuments", []],
      ["libredb.runningQueries", []],
      ["libredb.cancellableQueries", []],
    ]);
  });

  it("coalesces one synchronous turn of changes into one publication of each key", async () => {
    const { bindings, runs, published } = publisher();
    await Promise.resolve();
    published.length = 0;
    bindings.bind("untitled:Untitled-1", { connectionId: "c1" });
    bindings.bind("untitled:Untitled-2", { connectionId: "c1" });
    bindings.bind("file:///w/q.sql", { connectionId: "c2" });
    runs.prepare("untitled:Untitled-1", "c1");
    assert.deepEqual(published, []);
    await Promise.resolve();
    assert.deepEqual(published, [
      ["libredb.boundDocuments", ["untitled:Untitled-1", "untitled:Untitled-2", "file:///w/q.sql"]],
      ["libredb.runningQueries", ["untitled:Untitled-1"]],
      ["libredb.cancellableQueries", ["untitled:Untitled-1"]],
    ]);
  });

  it("publishes nothing after dispose", async () => {
    const { bindings, runs, published, keys } = publisher();
    await Promise.resolve();
    published.length = 0;
    keys.dispose();
    bindings.bind("untitled:Untitled-1", { connectionId: "c1" });
    runs.prepare("untitled:Untitled-1", "c1");
    await setImmediate();
    assert.deepEqual(published, []);
  });

  it("publishes nothing when disposed before a queued publication runs", async () => {
    const { published, keys } = publisher();
    keys.dispose();
    await setImmediate();
    assert.deepEqual(published, []);
  });

  it("logs a publication that failed at warn, and still publishes the next batch", async () => {
    let failing = true;
    const { bindings, published, warnings } = publisher((key) => failing && key === "libredb.runningQueries");
    await setImmediate();
    assert.deepEqual(warnings, ["Publishing libredb.runningQueries failed: the host is gone"]);
    failing = false;
    published.length = 0;
    bindings.bind("untitled:Untitled-1", { connectionId: "c1" });
    await setImmediate();
    assert.deepEqual(published, [
      ["libredb.boundDocuments", ["untitled:Untitled-1"]],
      ["libredb.runningQueries", []],
      ["libredb.cancellableQueries", []],
    ]);
    assert.equal(warnings.length, 1);
  });
});
