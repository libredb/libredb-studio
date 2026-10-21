import assert from "node:assert/strict";
import { BindingStore, editorRelease, renamedKey } from "../../../src/host/editor/bindings";
import { RunRegistry } from "../../../src/host/editor/run-registry";
import { CancellationTokenSource } from "../../fakes/vscode";

const UNTITLED = "untitled:Untitled-1";
const FILE = "file:///w/q.sql";
const SUB_A = "file:///w/sub/a.sql";

/** A store and the number of onDidChange events it has fired. */
function counted(): { store: BindingStore; events: () => number } {
  const store = new BindingStore();
  let fired = 0;
  store.onDidChange(() => {
    fired += 1;
  });
  return { store, events: () => fired };
}

describe("BindingStore", () => {
  it("answers a bound document's binding and forgets it on unbind", () => {
    const { store } = counted();
    store.bind(UNTITLED, { connectionId: "c1", catalog: "shop" });
    assert.deepEqual(store.get(UNTITLED), { connectionId: "c1", catalog: "shop" });
    store.unbind(UNTITLED);
    assert.equal(store.get(UNTITLED), undefined);
  });

  it("lists the bound keys in binding order", () => {
    const { store } = counted();
    store.bind(FILE, { connectionId: "c1" });
    store.bind(UNTITLED, { connectionId: "c2" });
    store.bind(SUB_A, { connectionId: "c1" });
    assert.deepEqual(store.keys(), [FILE, UNTITLED, SUB_A]);
  });

  it("fires once per call that changed the map", () => {
    const { store, events } = counted();
    store.bind(UNTITLED, { connectionId: "c1" });
    store.bind(UNTITLED, { connectionId: "c1", catalog: "shop" });
    store.move(UNTITLED, FILE);
    store.rename(FILE, "file:///w/r.sql");
    store.unbind("file:///w/r.sql");
    store.bind(UNTITLED, { connectionId: "c1" });
    store.unbindConnection("c1");
    assert.equal(events(), 7);
  });

  it("fires nothing for a call that changed nothing", () => {
    const { store, events } = counted();
    store.bind(UNTITLED, { connectionId: "c1", catalog: "shop" });
    const before = events();
    store.unbind(FILE);
    store.move(FILE, SUB_A);
    store.bind(UNTITLED, { connectionId: "c1", catalog: "shop" });
    assert.deepEqual(store.rename("file:///w/sub", "file:///w/lib"), []);
    assert.deepEqual(store.unbindConnection("c2"), []);
    assert.equal(events(), before);
  });

  it("moves a binding on Save As, leaving it only at the file", () => {
    const { store } = counted();
    store.bind(UNTITLED, { connectionId: "c1" });
    store.move(UNTITLED, FILE);
    assert.equal(store.get(UNTITLED), undefined);
    assert.deepEqual(store.get(FILE), { connectionId: "c1" });
    assert.deepEqual(store.keys(), [FILE]);
  });

  it("moves every binding under a renamed folder, and nothing beside it", () => {
    const { store } = counted();
    store.bind(SUB_A, { connectionId: "c1" });
    store.bind("file:///w/sub/b/c.sql", { connectionId: "c2" });
    store.bind("file:///w/subway.sql", { connectionId: "c3" });
    assert.deepEqual(store.rename("file:///w/sub", "file:///w/lib"), [
      [SUB_A, "file:///w/lib/a.sql"],
      ["file:///w/sub/b/c.sql", "file:///w/lib/b/c.sql"],
    ]);
    assert.deepEqual(store.get("file:///w/lib/a.sql"), { connectionId: "c1" });
    assert.deepEqual(store.get("file:///w/lib/b/c.sql"), { connectionId: "c2" });
    assert.deepEqual(store.get("file:///w/subway.sql"), { connectionId: "c3" });
    assert.equal(store.get(SUB_A), undefined);
  });

  it("reads a rename's every key before it moves one, so a key mapped onto another is never moved twice", () => {
    const { store } = counted();
    store.bind("file:///w/a", { connectionId: "c1" });
    store.bind("file:///w/a/a", { connectionId: "c2" });
    assert.deepEqual(store.rename("file:///w/a", "file:///w/a/a"), [
      ["file:///w/a", "file:///w/a/a"],
      ["file:///w/a/a", "file:///w/a/a/a"],
    ]);
    assert.deepEqual(store.get("file:///w/a/a"), { connectionId: "c1" });
    assert.deepEqual(store.get("file:///w/a/a/a"), { connectionId: "c2" });
    assert.equal(store.get("file:///w/a"), undefined);
  });

  it("unbinds every document of a connection and answers their keys", () => {
    const { store } = counted();
    store.bind(UNTITLED, { connectionId: "c1" });
    store.bind(FILE, { connectionId: "c2" });
    store.bind(SUB_A, { connectionId: "c1" });
    assert.deepEqual(store.unbindConnection("c1"), [UNTITLED, SUB_A]);
    assert.deepEqual(store.keys(), [FILE]);
  });

  it("disposes its emitter, so no listener hears a change after dispose", () => {
    const { store, events } = counted();
    store.dispose();
    store.bind(UNTITLED, { connectionId: "c1" });
    assert.equal(events(), 0);
  });
});

describe("editorRelease", () => {
  it("unbinds every editor of the connection and cancels each one's run, leaving other connections' editors", () => {
    const store = new BindingStore();
    const runs = new RunRegistry(() => new CancellationTokenSource());
    store.bind(UNTITLED, { connectionId: "c1" });
    store.bind(FILE, { connectionId: "c2" });
    store.bind(SUB_A, { connectionId: "c1" });
    const untitledRun = runs.prepare(UNTITLED, "c1");
    const fileRun = runs.prepare(FILE, "c2");
    editorRelease(store, runs).releaseConnection("c1");
    assert.deepEqual(store.keys(), [FILE]);
    assert.equal(untitledRun.tokenSource.token.isCancellationRequested, true);
    assert.equal(fileRun.tokenSource.token.isCancellationRequested, false);
    assert.equal(runs.of(FILE), fileRun);
  });
});

describe("editorRelease cancelRuns", () => {
  it("cancels every run on the connection, a preparing one included, and keeps every binding", () => {
    const store = new BindingStore();
    const runs = new RunRegistry(() => new CancellationTokenSource());
    store.bind(UNTITLED, { connectionId: "c1" });
    store.bind(FILE, { connectionId: "c2" });
    const preparing = runs.prepare(UNTITLED, "c1");
    const other = runs.prepare(FILE, "c2");
    editorRelease(store, runs).cancelRuns("c1");
    assert.deepEqual(store.keys(), [UNTITLED, FILE]);
    assert.equal(preparing.tokenSource.token.isCancellationRequested, true);
    assert.equal(other.tokenSource.token.isCancellationRequested, false);
  });
});

describe("renamedKey", () => {
  it("maps the renamed file itself", () => {
    assert.equal(renamedKey(FILE, FILE, "file:///w/r.sql"), "file:///w/r.sql");
  });

  it("maps a file under a renamed folder", () => {
    assert.equal(renamedKey(SUB_A, "file:///w/sub", "file:///w/lib"), "file:///w/lib/a.sql");
  });

  it("needs the slash after a folder's name", () => {
    assert.equal(renamedKey("file:///w/subway.sql", "file:///w/sub", "file:///w/lib"), undefined);
  });

  it("maps nothing outside the renamed resource", () => {
    assert.equal(renamedKey(UNTITLED, "file:///w", "file:///v"), undefined);
  });
});
