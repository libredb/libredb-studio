import assert from "node:assert/strict";
import { BindingStore } from "../../../src/host/editor/bindings";
import { CLOSE_GRACE_MS, DocumentLifecycle } from "../../../src/host/editor/document-lifecycle";
import { RunRegistry } from "../../../src/host/editor/run-registry";
import { FakeTextDocument, FakeTextEditor } from "../../fakes/documents";
import {
  CancellationTokenSource,
  closeDocument,
  languages,
  openDocument,
  renameFiles,
  saveDocument,
  Uri,
  window,
  workspace,
} from "../../fakes/vscode";

const UNTITLED = "untitled:Untitled-1";
const FILE = "file:///w/q.sql";

/** A timer the test runs by hand. */
interface Timer {
  readonly run: () => void;
  readonly ms: number;
  cleared: boolean;
}

/** A document at the uri over the text, in the language. */
function documentAt(uri: string, text = "select 1;", language = "sql") {
  return new FakeTextDocument(Uri.parse(uri), text, language);
}

/** The lifecycle over the fake workspace and window, a real BindingStore and RunRegistry, a recording presenter and timers. */
function setup() {
  const bindings = new BindingStore();
  const runs = new RunRegistry(() => new CancellationTokenSource());
  const presented: [string, ...string[]][] = [];
  const timers: Timer[] = [];
  const lifecycle = new DocumentLifecycle({
    workspace,
    window,
    bindings,
    runs,
    presenter: {
      documentClosed: (uri) => presented.push(["closed", uri]),
      documentMoved: (from, to) => presented.push(["moved", from, to]),
    },
    timers: {
      setTimeout: (run, ms) => {
        const timer: Timer = { run, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (handle) => {
        (handle as Timer).cleared = true;
      },
    },
  });
  /** Runs every timer not cleared and not yet run. */
  const expire = () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.run();
  };
  return { bindings, runs, presented, timers, lifecycle, expire };
}

/** A bound untitled document shown in the active editor, holding a preparing run. */
function boundUntitled(context: ReturnType<typeof setup>, text = "select 1;", language = "sql") {
  const untitled = documentAt(UNTITLED, text, language);
  window.activeTextEditor = new FakeTextEditor(untitled).asEditor();
  context.bindings.bind(UNTITLED, { connectionId: "c1" });
  const run = context.runs.prepare(UNTITLED, "c1");
  return { untitled, run };
}

describe("DocumentLifecycle", () => {
  it("waits CLOSE_GRACE_MS, 1000 ms", () => {
    assert.equal(CLOSE_GRACE_MS, 1000);
  });

  describe("Save As", () => {
    it("moves the binding, the run and the results once the untitled document closes inside the grace", () => {
      const context = setup();
      const { untitled, run } = boundUntitled(context);
      saveDocument(documentAt(FILE).asDocument());
      assert.deepEqual(
        context.timers.map((timer) => timer.ms),
        [1000],
      );
      closeDocument(untitled.asDocument());
      assert.equal(context.timers[0].cleared, true);
      assert.equal(context.bindings.get(UNTITLED), undefined);
      assert.deepEqual(context.bindings.get(FILE), { connectionId: "c1" });
      assert.equal(context.runs.of(UNTITLED), undefined);
      assert.equal(context.runs.of(FILE)?.tokenSource, run.tokenSource);
      assert.deepEqual(context.presented, [["moved", UNTITLED, FILE]]);
      context.expire();
      assert.deepEqual(context.bindings.get(FILE), { connectionId: "c1" });
      assert.equal(run.tokenSource.token.isCancellationRequested, false);
      assert.deepEqual(context.presented, [["moved", UNTITLED, FILE]]);
    });

    it("moves nothing when the text differs", () => {
      const context = setup();
      const { untitled } = boundUntitled(context);
      saveDocument(documentAt(FILE, "select 2;").asDocument());
      assert.equal(context.timers.length, 0);
      closeDocument(untitled.asDocument());
      assert.equal(context.bindings.get(FILE), undefined);
      assert.deepEqual(context.presented, []);
    });

    it("moves nothing when the language differs", () => {
      const context = setup();
      const { untitled } = boundUntitled(context);
      saveDocument(documentAt(FILE, "select 1;", "plaintext").asDocument());
      closeDocument(untitled.asDocument());
      assert.equal(context.bindings.get(FILE), undefined);
      assert.deepEqual(context.presented, []);
    });

    it("moves nothing when the active editor's document is not untitled, or is unbound, or there is none", () => {
      const context = setup();
      const other = documentAt("file:///w/other.sql");
      context.bindings.bind("file:///w/other.sql", { connectionId: "c1" });
      window.activeTextEditor = new FakeTextEditor(other).asEditor();
      saveDocument(documentAt(FILE).asDocument());
      window.activeTextEditor = new FakeTextEditor(documentAt("untitled:Untitled-2")).asEditor();
      saveDocument(documentAt(FILE).asDocument());
      window.activeTextEditor = undefined;
      saveDocument(documentAt(FILE).asDocument());
      assert.equal(context.timers.length, 0);
      assert.equal(context.bindings.get(FILE), undefined);
    });

    it("moves nothing when the saved document is already bound", () => {
      const context = setup();
      const { untitled } = boundUntitled(context);
      context.bindings.bind(FILE, { connectionId: "c2" });
      saveDocument(documentAt(FILE).asDocument());
      assert.equal(context.timers.length, 0);
      closeDocument(untitled.asDocument());
      assert.deepEqual(context.bindings.get(FILE), { connectionId: "c2" });
      assert.deepEqual(context.presented, []);
    });

    it("drops the candidate when its timer fires first, and a later close follows the plain close rule", () => {
      const context = setup();
      const { untitled, run } = boundUntitled(context);
      saveDocument(documentAt(FILE).asDocument());
      context.expire();
      closeDocument(untitled.asDocument());
      assert.equal(context.bindings.get(FILE), undefined);
      assert.deepEqual(context.bindings.get(UNTITLED), { connectionId: "c1" });
      assert.deepEqual(context.presented, []);
      context.expire();
      assert.equal(context.bindings.get(UNTITLED), undefined);
      assert.equal(run.tokenSource.token.isCancellationRequested, true);
      assert.deepEqual(context.presented, [["closed", UNTITLED]]);
    });

    it("keeps one candidate per untitled document, the latest save's", () => {
      const context = setup();
      const { untitled } = boundUntitled(context);
      saveDocument(documentAt("file:///w/first.sql").asDocument());
      saveDocument(documentAt(FILE).asDocument());
      assert.equal(context.timers[0].cleared, true);
      closeDocument(untitled.asDocument());
      assert.deepEqual(context.presented, [["moved", UNTITLED, FILE]]);
    });

    it("moves nothing in the Save All shape, where the untitled document never closes", () => {
      const context = setup();
      boundUntitled(context);
      saveDocument(documentAt(FILE).asDocument());
      context.expire();
      assert.equal(context.bindings.get(FILE), undefined);
      assert.deepEqual(context.bindings.get(UNTITLED), { connectionId: "c1" });
      assert.deepEqual(context.presented, []);
    });
  });

  describe("rename", () => {
    it("moves a renamed file's binding and run, and its results", () => {
      const context = setup();
      context.bindings.bind(FILE, { connectionId: "c1" });
      const run = context.runs.prepare(FILE, "c1");
      renameFiles([FILE, "file:///w/r.sql"]);
      assert.deepEqual(context.bindings.get("file:///w/r.sql"), { connectionId: "c1" });
      assert.equal(context.runs.of("file:///w/r.sql")?.tokenSource, run.tokenSource);
      assert.deepEqual(context.presented, [["moved", FILE, "file:///w/r.sql"]]);
    });

    it("moves every bound file under a renamed folder", () => {
      const context = setup();
      context.bindings.bind("file:///w/sub/a.sql", { connectionId: "c1" });
      context.bindings.bind("file:///w/sub/b.sql", { connectionId: "c2" });
      context.bindings.bind("file:///w/other.sql", { connectionId: "c1" });
      renameFiles(["file:///w/sub", "file:///w/lib"]);
      assert.deepEqual(context.bindings.keys(), ["file:///w/other.sql", "file:///w/lib/a.sql", "file:///w/lib/b.sql"]);
      assert.deepEqual(context.presented, [
        ["moved", "file:///w/sub/a.sql", "file:///w/lib/a.sql"],
        ["moved", "file:///w/sub/b.sql", "file:///w/lib/b.sql"],
      ]);
    });
  });

  describe("close", () => {
    it("keeps an untitled document's binding and run when it reopens inside the grace", () => {
      const context = setup();
      const { untitled, run } = boundUntitled(context);
      closeDocument(untitled.asDocument());
      openDocument(untitled.asDocument());
      assert.equal(context.timers[0].cleared, true);
      context.expire();
      assert.deepEqual(context.bindings.get(UNTITLED), { connectionId: "c1" });
      assert.equal(run.tokenSource.token.isCancellationRequested, false);
      assert.deepEqual(context.presented, []);
    });

    it("drops the closed document's binding, run and results at once when a new document with other text opens at its uri inside the grace", () => {
      const context = setup();
      const { untitled, run } = boundUntitled(context);
      closeDocument(untitled.asDocument());
      openDocument(documentAt(UNTITLED, "").asDocument());
      assert.equal(context.timers[0].cleared, true);
      assert.equal(context.bindings.get(UNTITLED), undefined);
      assert.equal(run.tokenSource.token.isCancellationRequested, true);
      assert.deepEqual(context.presented, [["closed", UNTITLED]]);
      context.expire();
      assert.deepEqual(context.presented, [["closed", UNTITLED]]);
    });

    it("drops an untitled document's binding, cancels its run and closes its results when the grace expires", () => {
      const context = setup();
      const { untitled, run } = boundUntitled(context);
      closeDocument(untitled.asDocument());
      assert.deepEqual(context.bindings.get(UNTITLED), { connectionId: "c1" });
      assert.equal(run.tokenSource.token.isCancellationRequested, false);
      assert.deepEqual(context.presented, []);
      assert.equal(context.timers[0].ms, 1000);
      context.expire();
      assert.equal(context.bindings.get(UNTITLED), undefined);
      assert.equal(run.tokenSource.token.isCancellationRequested, true);
      assert.deepEqual(context.presented, [["closed", UNTITLED]]);
    });

    it("closes the results of an unbound untitled document too, after the grace", () => {
      const context = setup();
      closeDocument(documentAt(UNTITLED).asDocument());
      context.expire();
      assert.deepEqual(context.presented, [["closed", UNTITLED]]);
    });

    it("restarts the grace when an untitled document closes again before it expired", () => {
      const context = setup();
      const { untitled } = boundUntitled(context);
      closeDocument(untitled.asDocument());
      closeDocument(untitled.asDocument());
      assert.equal(context.timers[0].cleared, true);
      context.expire();
      assert.deepEqual(context.presented, [["closed", UNTITLED]]);
    });

    it("keeps a file's binding, and cancels its run and closes its results at the close", () => {
      const context = setup();
      context.bindings.bind(FILE, { connectionId: "c1" });
      const run = context.runs.prepare(FILE, "c1");
      closeDocument(documentAt(FILE).asDocument());
      assert.deepEqual(context.bindings.get(FILE), { connectionId: "c1" });
      assert.equal(run.tokenSource.token.isCancellationRequested, true);
      assert.deepEqual(context.presented, [["closed", FILE]]);
      assert.equal(context.timers.length, 0);
    });

    it("keeps the binding through a language switch, which closes and reopens the document", async () => {
      const context = setup();
      const { untitled, run } = boundUntitled(context);
      await languages.setTextDocumentLanguage(untitled.asDocument(), "json");
      context.expire();
      assert.deepEqual(context.bindings.get(UNTITLED), { connectionId: "c1" });
      assert.equal(run.tokenSource.token.isCancellationRequested, false);
      assert.deepEqual(context.presented, []);
    });
  });

  it("stops listening and clears its pending timers on dispose", () => {
    const context = setup();
    const { untitled } = boundUntitled(context);
    saveDocument(documentAt(FILE).asDocument());
    closeDocument(documentAt("untitled:Untitled-2").asDocument());
    context.lifecycle.dispose();
    assert.deepEqual(
      context.timers.map((timer) => timer.cleared),
      [true, true],
    );
    closeDocument(untitled.asDocument());
    renameFiles([UNTITLED, FILE]);
    saveDocument(documentAt(FILE).asDocument());
    closeDocument(documentAt(FILE).asDocument());
    assert.equal(context.timers.length, 2);
    assert.deepEqual(context.presented, []);
    assert.deepEqual(context.bindings.get(UNTITLED), { connectionId: "c1" });
  });
});
