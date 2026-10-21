import assert from "node:assert/strict";
import { ALREADY_RUNNING, RunInFlightError, RunRegistry } from "../../../src/host/editor/run-registry";
import { CancellationTokenSource } from "../../fakes/vscode";

const UNTITLED = "untitled:Untitled-1";
const FILE = "file:///w/q.sql";

/** A fake token source that records whether the registry disposed it. */
class RecordingTokenSource extends CancellationTokenSource {
  disposed = false;

  override dispose(): void {
    this.disposed = true;
    super.dispose();
  }
}

/** A registry whose token sources are recorded in `sources`, and the number of onDidChange events it has fired. */
function counted(): { runs: RunRegistry; sources: RecordingTokenSource[]; events: () => number } {
  const sources: RecordingTokenSource[] = [];
  const runs = new RunRegistry(() => {
    const source = new RecordingTokenSource();
    sources.push(source);
    return source;
  });
  let fired = 0;
  runs.onDidChange(() => {
    fired += 1;
  });
  return { runs, sources, events: () => fired };
}

const SENT = { queryId: "q1", statement: "select 1", limit: 500, cancellable: false };

describe("RunRegistry", () => {
  describe("prepare", () => {
    it("registers a preparing run that is running and cancellable", () => {
      const { runs, sources } = counted();
      const prepared = runs.prepare(UNTITLED, "c1");
      assert.equal(prepared.phase, "preparing");
      assert.equal(prepared.uri, UNTITLED);
      assert.equal(prepared.connectionId, "c1");
      assert.equal(prepared.tokenSource, sources[0]);
      assert.equal(runs.of(UNTITLED), prepared);
      assert.deepEqual(runs.running(), [UNTITLED]);
      assert.deepEqual(runs.cancellable(), [UNTITLED]);
    });

    it("refuses a second run in the same editor", () => {
      const { runs } = counted();
      runs.prepare(UNTITLED, "c1");
      assert.throws(
        () => runs.prepare(UNTITLED, "c1"),
        (error: unknown) => error instanceof RunInFlightError && error.message === ALREADY_RUNNING,
      );
      assert.equal(ALREADY_RUNNING, "A query is already running in this editor.");
    });
  });

  describe("start", () => {
    it("replaces the preparing run with its running entry, on the same token source", () => {
      const { runs } = counted();
      const prepared = runs.prepare(UNTITLED, "c1");
      const entry = runs.start(prepared, SENT);
      assert.deepEqual(
        { ...entry, tokenSource: undefined },
        {
          phase: "running",
          uri: UNTITLED,
          connectionId: "c1",
          queryId: "q1",
          catalog: undefined,
          statement: "select 1",
          limit: 500,
          cancellable: false,
          tokenSource: undefined,
        },
      );
      assert.equal(entry.tokenSource, prepared.tokenSource);
      assert.equal(runs.of(UNTITLED), entry);
      assert.equal(runs.byQueryId("q1"), entry);
      assert.equal(runs.byQueryId("q2"), undefined);
      assert.deepEqual(runs.running(), [UNTITLED]);
      assert.deepEqual(runs.cancellable(), []);
    });

    it("keeps a running entry cancellable where the engine can cancel", () => {
      const { runs } = counted();
      const entry = runs.start(runs.prepare(UNTITLED, "c1"), { ...SENT, catalog: "shop", cancellable: true });
      assert.equal(entry.catalog, "shop");
      assert.deepEqual(runs.cancellable(), [UNTITLED]);
    });

    it("refuses a preparing run that was settled", () => {
      const { runs } = counted();
      const prepared = runs.prepare(UNTITLED, "c1");
      runs.settle(prepared);
      assert.throws(() => runs.start(prepared, SENT), {
        message: "The run of untitled:Untitled-1 is no longer registered.",
      });
    });

    it("refuses a preparing run that was cleared, even when a new run holds the uri", () => {
      const { runs } = counted();
      const prepared = runs.prepare(UNTITLED, "c1");
      runs.clear();
      runs.prepare(UNTITLED, "c1");
      assert.throws(() => runs.start(prepared, SENT), {
        message: "The run of untitled:Untitled-1 is no longer registered.",
      });
    });
  });

  describe("settle", () => {
    it("removes the run, disposes its token source and fires", () => {
      const { runs, sources, events } = counted();
      const entry = runs.start(runs.prepare(UNTITLED, "c1"), SENT);
      const before = events();
      runs.settle(entry);
      assert.equal(runs.of(UNTITLED), undefined);
      assert.deepEqual(runs.running(), []);
      assert.equal(sources[0]?.disposed, true);
      assert.equal(events(), before + 1);
    });

    it("removes nothing when the run is no longer its uri's", () => {
      const { runs, sources, events } = counted();
      const old = runs.prepare(UNTITLED, "c1");
      runs.clear();
      const current = runs.prepare(UNTITLED, "c2");
      const before = events();
      runs.settle(old);
      assert.equal(runs.of(UNTITLED), current);
      assert.equal(sources[1]?.disposed, false);
      assert.equal(events(), before);
    });
  });

  describe("cancelUri", () => {
    it("cancels the uri's token and leaves the run registered until it settles", () => {
      const { runs, events } = counted();
      const entry = runs.start(runs.prepare(UNTITLED, "c1"), SENT);
      const before = events();
      runs.cancelUri(UNTITLED);
      assert.equal(entry.tokenSource.token.isCancellationRequested, true);
      assert.equal(runs.of(UNTITLED), entry);
      assert.equal(events(), before);
    });

    it("does nothing for a uri with no run", () => {
      const { runs, events } = counted();
      runs.cancelUri(UNTITLED);
      assert.equal(events(), 0);
    });
  });

  describe("cancelConnection", () => {
    it("cancels every run on the connection, preparing or running, and leaves them registered", () => {
      const { runs, events } = counted();
      const preparing = runs.prepare(UNTITLED, "c1");
      const running = runs.start(runs.prepare(FILE, "c1"), SENT);
      const other = runs.prepare("file:///w/other.sql", "c2");
      const before = events();
      runs.cancelConnection("c1");
      assert.equal(preparing.tokenSource.token.isCancellationRequested, true);
      assert.equal(running.tokenSource.token.isCancellationRequested, true);
      assert.equal(other.tokenSource.token.isCancellationRequested, false);
      assert.deepEqual(runs.running(), [UNTITLED, FILE, "file:///w/other.sql"]);
      assert.equal(events(), before);
    });
  });

  describe("uriOf", () => {
    it("answers the key a run is registered under now, after a move", () => {
      const { runs } = counted();
      const prepared = runs.prepare(UNTITLED, "c1");
      assert.equal(runs.uriOf(prepared), UNTITLED);
      runs.move(UNTITLED, FILE);
      assert.equal(runs.uriOf(prepared), FILE);
    });

    it("answers undefined for a run that settled", () => {
      const { runs } = counted();
      const prepared = runs.prepare(UNTITLED, "c1");
      runs.settle(prepared);
      assert.equal(runs.uriOf(prepared), undefined);
    });
  });

  describe("move and rename", () => {
    it("moves a run on Save As, keeping its queryId and token", () => {
      const { runs, events } = counted();
      const entry = runs.start(runs.prepare(UNTITLED, "c1"), SENT);
      const before = events();
      runs.move(UNTITLED, FILE);
      const moved = runs.of(FILE);
      assert.equal(runs.of(UNTITLED), undefined);
      assert.equal(moved?.uri, FILE);
      assert.equal(moved?.phase === "running" && moved.queryId, "q1");
      assert.equal(moved?.tokenSource, entry.tokenSource);
      assert.equal(runs.byQueryId("q1"), moved);
      assert.deepEqual(runs.running(), [FILE]);
      assert.equal(events(), before + 1);
    });

    it("moves a preparing run, so start finds it under its new key", () => {
      const { runs } = counted();
      const prepared = runs.prepare(UNTITLED, "c1");
      runs.move(UNTITLED, FILE);
      const moved = runs.of(FILE);
      assert.equal(moved?.phase, "preparing");
      const entry = runs.start(prepared, SENT);
      assert.equal(entry.uri, FILE);
      assert.equal(runs.of(FILE), entry);
    });

    it("settles a moved run under its new key", () => {
      const { runs } = counted();
      const entry = runs.start(runs.prepare(UNTITLED, "c1"), SENT);
      runs.move(UNTITLED, FILE);
      runs.settle(entry);
      assert.deepEqual(runs.running(), []);
    });

    it("moves nothing and fires nothing from a uri with no run", () => {
      const { runs, events } = counted();
      runs.move(UNTITLED, FILE);
      assert.equal(events(), 0);
    });

    it("renames every run under a folder, and nothing beside it", () => {
      const { runs, events } = counted();
      runs.prepare("file:///w/sub/a.sql", "c1");
      runs.start(runs.prepare("file:///w/sub/b/c.sql", "c1"), SENT);
      runs.prepare("file:///w/subway.sql", "c1");
      runs.prepare(UNTITLED, "c1");
      const before = events();
      runs.rename("file:///w/sub", "file:///w/lib");
      assert.deepEqual([...runs.running()].sort(), [
        "file:///w/lib/a.sql",
        "file:///w/lib/b/c.sql",
        "file:///w/subway.sql",
        UNTITLED,
      ]);
      assert.equal(runs.byQueryId("q1")?.uri, "file:///w/lib/b/c.sql");
      assert.equal(events(), before + 1);
    });

    it("renames the renamed file itself", () => {
      const { runs } = counted();
      runs.prepare(FILE, "c1");
      runs.rename(FILE, "file:///w/r.sql");
      assert.deepEqual(runs.running(), ["file:///w/r.sql"]);
    });

    it("fires nothing for a rename that maps no run", () => {
      const { runs, events } = counted();
      runs.prepare(UNTITLED, "c1");
      const before = events();
      runs.rename("file:///w", "file:///v");
      assert.deepEqual(runs.running(), [UNTITLED]);
      assert.equal(events(), before);
    });
  });

  describe("clear", () => {
    it("forgets every run and fires once", () => {
      const { runs, events } = counted();
      runs.prepare(UNTITLED, "c1");
      runs.start(runs.prepare(FILE, "c1"), { ...SENT, cancellable: true });
      const before = events();
      runs.clear();
      assert.deepEqual(runs.running(), []);
      assert.deepEqual(runs.cancellable(), []);
      assert.equal(events(), before + 1);
    });

    it("fires nothing when there is nothing to forget", () => {
      const { runs, events } = counted();
      runs.clear();
      assert.equal(events(), 0);
    });
  });

  it("fires once per changing call", () => {
    const { runs, events } = counted();
    const prepared = runs.prepare(UNTITLED, "c1");
    const entry = runs.start(prepared, SENT);
    runs.settle(entry);
    assert.equal(events(), 3);
  });

  it("disposes its emitter, so no listener hears a change after dispose", () => {
    const { runs, events } = counted();
    runs.dispose();
    runs.prepare(UNTITLED, "c1");
    assert.equal(events(), 0);
  });
});
