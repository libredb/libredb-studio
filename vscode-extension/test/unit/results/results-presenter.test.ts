import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BackendError, BackendExitedError } from "../../../src/host/backend-client";
import { ALREADY_RUNNING, RunInFlightError } from "../../../src/host/editor/run-registry";
import { LogResultsPresenter } from "../../../src/host/results/log-presenter";
import {
  fanOut,
  gridContextOf,
  LOAD_MORE_REFUSED,
  type PageRead,
  type ResultsPresenter,
  type ResultsSurface,
  ResultsViewPresenter,
  type RunStart,
} from "../../../src/host/results/results-presenter";
import type { ProviderDescription, QueryPage } from "../../../src/protocol";
import { type HostToWebview, parseHostMessage } from "../../../src/results-protocol";
import { ZERO_LEVELS } from "../../fakes/descriptions";
import {
  EMPTY_AND_NOTICES,
  FAILURES,
  LOAD_MORE_ON_POSTGRES,
  MONGODB_DOCUMENTS,
  POSTGRES_GRID,
  RUN_A,
  RUN_B,
  STARTED_AT,
  SYNTHETIC_RUN_FAILED_WITH_DETAIL,
} from "../../fixtures/results-sequences";

const NOW = STARTED_AT;
const UNTITLED = "untitled:Untitled-1";
const FILE_A = "file:///w/a.sql";

/** ZERO_LEVELS with the given capabilities over its own. */
function described(capabilities: Partial<ProviderDescription["capabilities"]>): ProviderDescription {
  return { ...ZERO_LEVELS, capabilities: { ...ZERO_LEVELS.capabilities, ...capabilities } };
}

const PAGINATED = described({ supportsResultPagination: true });

function start(over: Partial<RunStart> = {}): RunStart {
  return {
    queryId: "q1",
    documentUri: UNTITLED,
    documentLabel: "Untitled-1",
    connectionId: "c1",
    connectionName: "shop",
    connectionType: "postgres",
    description: PAGINATED,
    statement: "select 1",
    limit: 500,
    ...over,
  };
}

function page(rows: Record<string, unknown>[], pagination: Partial<QueryPage["pagination"]> = {}): QueryPage {
  return {
    rows,
    fields: rows.length > 0 ? Object.keys(rows[0]) : [],
    rowCount: rows.length,
    executionTime: 4,
    pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: rows.length, wasLimited: false, ...pagination },
  };
}

/** A promise and the functions that settle it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A presenter on a surface that records each post (checked by the webview's guard), reveal and description, a page
 * runner that records each read and answers when the test settles it, and run ids RUN_A, RUN_B, then fresh UUIDs.
 */
function setup(runIds: string[] = [RUN_A, RUN_B], now = NOW) {
  const posted: HostToWebview[] = [];
  const descriptions: (string | undefined)[] = [];
  let reveals = 0;
  const surface: ResultsSurface = {
    post: (message) => {
      parseHostMessage(message);
      posted.push(message);
    },
    reveal: () => {
      reveals += 1;
    },
    describe: (description) => descriptions.push(description),
  };
  const reads: PageRead[] = [];
  const answers: ReturnType<typeof deferred<QueryPage>>[] = [];
  const lines: [string, string][] = [];
  const ids = [...runIds];
  const presenter = new ResultsViewPresenter({
    surface,
    pages: {
      runPage: (read) => {
        reads.push(read);
        const answer = deferred<QueryPage>();
        answers.push(answer);
        return answer.promise;
      },
    },
    log: {
      warn: (message: string) => lines.push(["warn", message]),
      error: (message: string | Error) => lines.push(["error", String(message)]),
    },
    newRunId: () => ids.shift() ?? randomUUID(),
    now: () => now,
  });
  return {
    presenter,
    posted,
    descriptions,
    reads,
    answers,
    lines,
    get reveals() {
      return reveals;
    },
  };
}

describe("gridContextOf", () => {
  it("builds the grid context from the type and the description, with no masking key unless declared", () => {
    const grid = gridContextOf("postgres", PAGINATED);
    assert.deepEqual(grid, POSTGRES_GRID);
    assert.equal(Object.hasOwn(grid, "maskingExemptColumns"), false);

    const exempt = { column: "_id", reason: "the document key" };
    assert.deepEqual(
      gridContextOf("postgres", described({ supportsResultPagination: true, maskingExemptColumns: exempt })),
      {
        ...POSTGRES_GRID,
        maskingExemptColumns: exempt,
      },
    );
    assert.equal(gridContextOf("postgres", ZERO_LEVELS).supportsResultPagination, false);
  });

  it("names the description's commit keyword", () => {
    assert.equal(
      gridContextOf("postgres", { ...PAGINATED, commitKeyword: "COMMIT WORK" }).commitKeyword,
      "COMMIT WORK",
    );
  });
});

describe("ResultsViewPresenter: runs", () => {
  it("starts a run with a host-minted runId, reveals the view and describes the document", () => {
    const view = setup();
    view.presenter.runStarted(start());
    assert.deepEqual(view.posted, [{ v: 1, type: "runStarted", runId: RUN_A, statement: "select 1", startedAt: NOW }]);
    assert.notEqual(RUN_A, "q1");
    assert.equal(view.reveals, 1);
    assert.deepEqual(view.descriptions, ["Untitled-1 on shop"]);
  });

  it("posts the answered page unchanged with the run's grid, and an error through the failure table", () => {
    const view = setup();
    view.presenter.runStarted(start());
    const answered = page([{ n: 1 }]);
    view.presenter.runSucceeded("q1", answered);
    assert.deepEqual(view.posted[1], { v: 1, type: "runSucceeded", runId: RUN_A, page: answered, grid: POSTGRES_GRID });
    assert.equal((view.posted[1] as { page: QueryPage }).page, answered);

    view.presenter.runStarted(start({ queryId: "q2" }));
    view.presenter.runFailed("q2", new BackendError(400, "QUERY_ERROR", "boom"));
    assert.deepEqual(view.posted.at(-1), {
      v: 1,
      type: "runFailed",
      runId: RUN_B,
      failure: { kind: "error", message: "boom" },
    });
  });

  it("drops a replaced run's answers, and an answer no record holds (run step 5)", () => {
    const view = setup();
    view.presenter.runStarted(start({ queryId: "q1" }));
    view.presenter.runStarted(start({ queryId: "q2" }));
    const before = view.presenter.replay();
    assert.equal((before[0] as { runId: string }).runId, RUN_B);
    const count = view.posted.length;

    view.presenter.runSucceeded("q1", page([{ n: 1 }]));
    view.presenter.runFailed("q1", new BackendError(400, "QUERY_ERROR", "boom"));
    view.presenter.runSucceeded("nobody", page([{ n: 1 }]));
    view.presenter.runFailed("nobody", new BackendError(400, "QUERY_ERROR", "boom"));
    assert.equal(view.posted.length, count);
    assert.deepEqual(view.presenter.replay(), before);
  });

  it("shows the last document a run started on, and posts nothing for another document's answer", () => {
    const view = setup();
    view.presenter.runStarted(start({ queryId: "qa", documentUri: FILE_A, documentLabel: "a.sql" }));
    view.presenter.runStarted(start({ queryId: "qb", connectionName: "stock" }));
    const count = view.posted.length;
    view.presenter.runSucceeded("qa", page([{ n: 1 }]));
    view.presenter.runFailed("qa", new BackendError(400, "QUERY_ERROR", "boom"));
    assert.equal(view.posted.length, count);
    assert.deepEqual(view.descriptions.at(-1), "Untitled-1 on stock");
    assert.equal((view.presenter.replay()[0] as { runId: string }).runId, RUN_B);
  });

  it("replays the live sequence: clear with no record, then running, succeeded and failed", () => {
    const view = setup();
    assert.deepEqual(view.presenter.replay(), [{ v: 1, type: "clear" }]);

    view.presenter.runStarted(start());
    assert.deepEqual(view.presenter.replay(), view.posted);
    view.presenter.runSucceeded("q1", page([{ n: 1 }]));
    assert.deepEqual(view.presenter.replay(), view.posted);

    const failing = setup();
    failing.presenter.runStarted(start());
    failing.presenter.runFailed("q1", new BackendError(400, "QUERY_ERROR", "boom"));
    assert.deepEqual(failing.presenter.replay(), failing.posted);
    assert.equal(failing.posted.length, 2);
    for (const message of [...view.presenter.replay(), ...failing.presenter.replay()]) parseHostMessage(message);
  });

  it("changes nothing on a close or a move of a document with no record", () => {
    const view = setup();
    view.presenter.runStarted(start());
    const before = view.presenter.replay();
    const count = view.posted.length;
    const presenter: ResultsPresenter = view.presenter;
    presenter.documentClosed("untitled:Untitled-9");
    presenter.documentMoved("untitled:Untitled-9", "file:///w/other.sql");
    assert.equal(view.posted.length, count);
    assert.deepEqual(view.presenter.replay(), before);
  });
});

describe("fanOut", () => {
  it("hands each of the five calls to every presenter in order, with the same arguments", () => {
    const calls: [string, string, ...unknown[]][] = [];
    const recording = (name: string): ResultsPresenter => ({
      runStarted: (run) => calls.push([name, "runStarted", run]),
      runSucceeded: (queryId, answered) => calls.push([name, "runSucceeded", queryId, answered]),
      runFailed: (queryId, error) => calls.push([name, "runFailed", queryId, error]),
      documentClosed: (uri) => calls.push([name, "documentClosed", uri]),
      documentMoved: (from, to) => calls.push([name, "documentMoved", from, to]),
    });
    const both = fanOut(recording("a"), recording("b"));
    const run = start();
    const answered = page([]);
    const error = new Error("boom");
    both.runStarted(run);
    both.runSucceeded("q1", answered);
    both.runFailed("q1", error);
    both.documentClosed(UNTITLED);
    both.documentMoved(UNTITLED, FILE_A);
    assert.deepEqual(calls, [
      ["a", "runStarted", run],
      ["b", "runStarted", run],
      ["a", "runSucceeded", "q1", answered],
      ["b", "runSucceeded", "q1", answered],
      ["a", "runFailed", "q1", error],
      ["b", "runFailed", "q1", error],
      ["a", "documentClosed", UNTITLED],
      ["b", "documentClosed", UNTITLED],
      ["a", "documentMoved", UNTITLED, FILE_A],
      ["b", "documentMoved", UNTITLED, FILE_A],
    ]);
  });

  it("logs a run that failed with an error no table row names once, with its stack, beside the log presenter", () => {
    const view = setup();
    const log = new LogResultsPresenter({
      info: () => undefined,
      warn: (message: string) => view.lines.push(["warn", message]),
      error: (message: string | Error) => view.lines.push(["error", String(message)]),
    });
    const both = fanOut(view.presenter, log);
    both.runStarted(start());
    const error = new RunInFlightError();
    both.runFailed("q1", error);
    assert.deepEqual(view.lines, [["error", `Run q1 failed: ${error.message}\n${error.stack}`]]);
    assert.deepEqual(view.posted.at(-1), {
      v: 1,
      type: "runFailed",
      runId: RUN_A,
      failure: { kind: "error", message: ALREADY_RUNNING },
    });
  });
});

/** The field of a fixture message, read by its type so a case drives the presenter with the fixture's own values. */
function field<T extends HostToWebview["type"], K extends keyof Extract<HostToWebview, { type: T }>>(
  message: HostToWebview,
  type: T,
  key: K,
): Extract<HostToWebview, { type: T }>[K] {
  assert.equal(message.type, type);
  return (message as Extract<HostToWebview, { type: T }>)[key];
}

/** `Load More was refused: <reason>.`, logged as a warning. */
const refused = (reason: string): [string, string] => ["warn", `Load More was refused: ${reason}.`];

/** A presenter whose run on UNTITLED answered `first`: a page with hasMore and limit 2 unless given. */
function answered(
  first: QueryPage = page([{ n: 1 }, { n: 2 }], { limit: 2, hasMore: true }),
  over: Partial<RunStart> = {},
) {
  const view = setup();
  view.presenter.runStarted(start(over));
  view.presenter.runSucceeded(over.queryId ?? "q1", first);
  return view;
}

describe("ResultsViewPresenter: Load More", () => {
  it("reads each page at the first page's limit and the rows returned so far, until no more rows follow", async () => {
    const view = answered(page([{ n: 1 }, { n: 2 }], { limit: 2, hasMore: true }), {
      statement: "select n from t",
      limit: 500,
    });
    const count = view.posted.length;

    const first = view.presenter.loadMore(RUN_A);
    assert.deepEqual(view.posted.slice(count), [{ v: 1, type: "pageStarted", runId: RUN_A }]);
    assert.deepEqual(view.reads, [
      { documentUri: UNTITLED, connectionId: "c1", statement: "select n from t", limit: 2, offset: 2 },
    ]);
    const second = page([{ n: 3 }, { n: 4 }], { limit: 2, offset: 2, hasMore: true });
    view.answers[0].resolve(second);
    await first;
    assert.deepEqual(view.posted.at(-1), { v: 1, type: "pageAppended", runId: RUN_A, page: second });

    const readTwo = view.presenter.loadMore(RUN_A);
    assert.equal(view.reads[1].offset, 4);
    assert.equal(view.reads[1].limit, 2);
    const third = page([{ n: 5 }], { limit: 2, offset: 4, hasMore: false });
    view.answers[1].resolve(third);
    await readTwo;
    assert.deepEqual(view.posted.at(-1), { v: 1, type: "pageAppended", runId: RUN_A, page: third });

    const posted = view.posted.length;
    await view.presenter.loadMore(RUN_A);
    assert.equal(view.reads.length, 2);
    assert.equal(view.posted.length, posted);
    assert.deepEqual(view.lines, [refused(LOAD_MORE_REFUSED.noMore)]);
    assert.deepEqual(view.presenter.replay(), view.posted);
  });

  it("reads the statement, catalog and connection the run was sent with, and no catalog key without one", async () => {
    const sales = answered(undefined, { statement: "select * from orders", catalog: "sales", connectionId: "c9" });
    void sales.presenter.loadMore(RUN_A);
    assert.deepEqual(sales.reads, [
      {
        documentUri: UNTITLED,
        connectionId: "c9",
        statement: "select * from orders",
        catalog: "sales",
        limit: 2,
        offset: 2,
      },
    ]);
    const plain = answered();
    void plain.presenter.loadMore(RUN_A);
    assert.equal(Object.hasOwn(plain.reads[0], "catalog"), false);
  });

  it("refuses each case of criterion 7 with no read, logging its reason", async () => {
    const unknown = answered();
    await unknown.presenter.loadMore(randomUUID());
    assert.deepEqual(unknown.lines, [refused(LOAD_MORE_REFUSED.unknownRun)]);

    const replaced = answered();
    replaced.presenter.runStarted(start({ queryId: "q2" }));
    await replaced.presenter.loadMore(RUN_A);
    assert.deepEqual(replaced.lines, [refused(LOAD_MORE_REFUSED.unknownRun)]);

    const running = setup();
    running.presenter.runStarted(start());
    await running.presenter.loadMore(RUN_A);
    const failed = setup();
    failed.presenter.runStarted(start());
    failed.presenter.runFailed("q1", new BackendError(400, "QUERY_ERROR", "boom"));
    await failed.presenter.loadMore(RUN_A);
    assert.deepEqual(
      [...running.lines, ...failed.lines],
      [refused(LOAD_MORE_REFUSED.notSucceeded), refused(LOAD_MORE_REFUSED.notSucceeded)],
    );

    const done = answered(page([{ n: 1 }], { limit: 2, hasMore: false }));
    await done.presenter.loadMore(RUN_A);
    assert.deepEqual(done.lines, [refused(LOAD_MORE_REFUSED.noMore)]);

    const unpaged = answered(undefined, { description: described({ supportsResultPagination: false }) });
    await unpaged.presenter.loadMore(RUN_A);
    assert.deepEqual(unpaged.lines, [refused(LOAD_MORE_REFUSED.noPagination)]);

    const busy = answered();
    void busy.presenter.loadMore(RUN_A);
    const posted = busy.posted.length;
    await busy.presenter.loadMore(RUN_A);
    assert.equal(busy.reads.length, 1);
    assert.equal(busy.posted.length, posted);
    assert.deepEqual(busy.lines, [refused(LOAD_MORE_REFUSED.inFlight)]);

    for (const view of [unknown, replaced, running, failed, done, unpaged]) assert.deepEqual(view.reads, []);
  });

  it("keeps the rows of a failed page, replays the failure, and lets Load More run again", async () => {
    const view = answered();
    const rows = view.presenter.replay();
    const read = view.presenter.loadMore(RUN_A);
    view.answers[0].reject(new BackendError(400, "QUERY_ERROR", "canceling statement due to statement timeout"));
    await read;
    const failure = { kind: "error", message: "canceling statement due to statement timeout" };
    assert.deepEqual(view.posted.at(-1), { v: 1, type: "pageFailed", runId: RUN_A, failure });
    const replay = view.presenter.replay();
    assert.deepEqual(replay, [...rows, { v: 1, type: "pageStarted", runId: RUN_A }, view.posted.at(-1)]);

    const again = view.presenter.loadMore(RUN_A);
    assert.deepEqual(view.posted.at(-1), { v: 1, type: "pageStarted", runId: RUN_A });
    assert.equal(view.reads[1].offset, 2);
    const during = view.presenter.replay();
    assert.deepEqual(during.at(-1), { v: 1, type: "pageStarted", runId: RUN_A });
    assert.equal(
      during.some((message) => message.type === "pageFailed"),
      false,
    );
    view.answers[1].resolve(page([{ n: 3 }], { limit: 2, offset: 2 }));
    await again;
    assert.equal(view.presenter.replay().at(-1)?.type, "pageAppended");
  });

  it("shows a cancelled read as cancelled and a read refused by a preparing Run as that refusal (H6)", async () => {
    const cancelled = answered();
    const read = cancelled.presenter.loadMore(RUN_A);
    cancelled.answers[0].reject(new BackendError(499, "QUERY_CANCELLED", "Query was cancelled"));
    await read;
    assert.deepEqual(cancelled.posted.at(-1), {
      v: 1,
      type: "pageFailed",
      runId: RUN_A,
      failure: { kind: "cancelled" },
    });
    assert.equal(cancelled.presenter.replay()[1].type, "runSucceeded");

    const preparing = answered();
    const refusedRead = preparing.presenter.loadMore(RUN_A);
    preparing.answers[0].reject(new RunInFlightError());
    await refusedRead;
    assert.deepEqual(preparing.posted.at(-1), {
      v: 1,
      type: "pageFailed",
      runId: RUN_A,
      failure: { kind: "error", message: ALREADY_RUNNING },
    });
    // A page read reaches no log presenter, so the view's presenter logs its stack: one line.
    assert.equal(preparing.lines.length, 1);
    assert.ok(preparing.lines[0][1].includes(ALREADY_RUNNING));
  });

  it("drops a read whose run was replaced, and posts nothing for a read answered while another document shows", async () => {
    const view = answered();
    const read = view.presenter.loadMore(RUN_A);
    view.presenter.runStarted(start({ queryId: "q2" }));
    const after = view.presenter.replay();
    const count = view.posted.length;
    view.answers[0].resolve(page([{ n: 3 }], { limit: 2, offset: 2 }));
    await read;
    assert.equal(view.posted.length, count);
    assert.deepEqual(view.presenter.replay(), after);

    const failing = answered();
    const failingRead = failing.presenter.loadMore(RUN_A);
    failing.presenter.runStarted(start({ queryId: "q2" }));
    const failingCount = failing.posted.length;
    failing.answers[0].reject(new BackendError(400, "QUERY_ERROR", "boom"));
    await failingRead;
    assert.equal(failing.posted.length, failingCount);

    const elsewhere = answered();
    const elsewhereRead = elsewhere.presenter.loadMore(RUN_A);
    elsewhere.presenter.runStarted(start({ queryId: "qb", documentUri: FILE_A, documentLabel: "a.sql" }));
    const elsewhereCount = elsewhere.posted.length;
    elsewhere.answers[0].resolve(page([{ n: 3 }], { limit: 2, offset: 2 }));
    await elsewhereRead;
    assert.equal(elsewhere.posted.length, elsewhereCount);
  });
});

describe("ResultsViewPresenter: the recorded sequences the browser leg renders", () => {
  /** A presenter whose run id is the fixture's and whose clock is the fixture's, started as `sequence[0]` says. */
  function replaying(sequence: HostToWebview[], over: Partial<RunStart> = {}) {
    const view = setup([field(sequence[0], "runStarted", "runId")], STARTED_AT);
    view.presenter.runStarted(start({ statement: field(sequence[0], "runStarted", "statement"), ...over }));
    return view;
  }

  it("posts LOAD_MORE_ON_POSTGRES for Select Rows at row limit 2 and one Load More", async () => {
    const view = replaying(LOAD_MORE_ON_POSTGRES, { limit: 2 });
    view.presenter.runSucceeded("q1", field(LOAD_MORE_ON_POSTGRES[1], "runSucceeded", "page"));
    const read = view.presenter.loadMore(RUN_A);
    view.answers[0].resolve(field(LOAD_MORE_ON_POSTGRES[3], "pageAppended", "page"));
    await read;
    assert.deepEqual(view.posted, LOAD_MORE_ON_POSTGRES);
    assert.deepEqual(view.presenter.replay(), LOAD_MORE_ON_POSTGRES);
  });

  it("posts each FAILURES sequence through the failure table", async () => {
    const pageFailed = replaying(FAILURES.pageFailed, { limit: 2 });
    pageFailed.presenter.runSucceeded("q1", field(FAILURES.pageFailed[1], "runSucceeded", "page"));
    const read = pageFailed.presenter.loadMore(RUN_A);
    pageFailed.answers[0].reject(new BackendError(400, "QUERY_ERROR", "canceling statement due to statement timeout"));
    await read;

    const runFailed = replaying(FAILURES.runFailed);
    runFailed.presenter.runFailed("q1", new BackendError(400, "QUERY_ERROR", 'relation "it_missing" does not exist'));
    const cancelled = replaying(FAILURES.cancelled);
    cancelled.presenter.runFailed("q1", new BackendError(499, "QUERY_CANCELLED", "Query was cancelled"));
    const backendExited = replaying(FAILURES.backendExited);
    backendExited.presenter.runFailed("q1", new BackendExitedError({ exitCode: null, signal: "SIGKILL" }));

    for (const [name, view] of Object.entries({ pageFailed, runFailed, cancelled, backendExited })) {
      const sequence = FAILURES[name as keyof typeof FAILURES];
      assert.deepEqual(view.posted, sequence, name);
      assert.deepEqual(view.presenter.replay(), sequence, name);
    }
  });

  // FAILURES.runFailed holds no detail, as no live run answers one (D389), so the detail goes through the synthetic case.
  it("posts SYNTHETIC_RUN_FAILED_WITH_DETAIL for an error whose details carry the driver's detail", () => {
    const view = replaying(SYNTHETIC_RUN_FAILED_WITH_DETAIL);
    view.presenter.runFailed(
      "q1",
      new BackendError(400, "QUERY_ERROR", 'duplicate key value violates unique constraint "it_unique_pkey"', {
        details: { detail: "Key (id)=(1) already exists." },
      }),
    );
    assert.deepEqual(view.posted, SYNTHETIC_RUN_FAILED_WITH_DETAIL);
    assert.deepEqual(view.presenter.replay(), SYNTHETIC_RUN_FAILED_WITH_DETAIL);
  });

  it("posts each EMPTY_AND_NOTICES sequence", () => {
    for (const [name, sequence] of Object.entries(EMPTY_AND_NOTICES)) {
      const view = replaying(sequence, { limit: 2 });
      view.presenter.runSucceeded("q1", field(sequence[1], "runSucceeded", "page"));
      assert.deepEqual(view.posted, sequence, name);
      assert.deepEqual(view.presenter.replay(), sequence, name);
    }
  });

  it("posts MONGODB_DOCUMENTS for a run on a connection that does not page its results", () => {
    const view = replaying(MONGODB_DOCUMENTS, {
      connectionType: "mongodb",
      description: described({ supportsResultPagination: false }),
    });
    view.presenter.runSucceeded("q1", field(MONGODB_DOCUMENTS[1], "runSucceeded", "page"));
    assert.deepEqual(view.posted, MONGODB_DOCUMENTS);
    assert.deepEqual(view.presenter.replay(), MONGODB_DOCUMENTS);
  });
});

describe("ResultsViewPresenter: the active editor, a close and a move", () => {
  const UNTITLED_2 = "untitled:Untitled-2";

  /** A run on FILE_A that answered two pages, then a run on UNTITLED_2 that answered one: B is current. */
  async function twoDocuments() {
    const view = setup();
    view.presenter.runStarted(start({ queryId: "qa", documentUri: FILE_A, documentLabel: "a.sql" }));
    view.presenter.runSucceeded("qa", page([{ n: 1 }, { n: 2 }], { limit: 2, hasMore: true }));
    const read = view.presenter.loadMore(RUN_A);
    view.answers[0].resolve(page([{ n: 3 }], { limit: 2, offset: 2 }));
    await read;
    const aSequence = [...view.posted];
    view.presenter.runStarted(
      start({ queryId: "qb", documentUri: UNTITLED_2, documentLabel: "Untitled-2", connectionName: "stock" }),
    );
    view.presenter.runSucceeded("qb", page([{ m: 1 }]));
    const bSequence = view.posted.slice(aSequence.length);
    return { view, aSequence, bSequence };
  }

  it("shows the active editor's record, and leaves the view as it is for an editor with none (criterion 14)", async () => {
    const { view, aSequence, bSequence } = await twoDocuments();
    assert.equal(aSequence.length, 4);

    let count = view.posted.length;
    view.presenter.activeDocumentChanged(FILE_A);
    assert.deepEqual(view.posted.slice(count), aSequence);
    assert.deepEqual(view.descriptions.at(-1), "a.sql on shop");

    count = view.posted.length;
    view.presenter.activeDocumentChanged(UNTITLED_2);
    assert.deepEqual(view.posted.slice(count), bSequence);
    assert.deepEqual(view.descriptions.at(-1), "Untitled-2 on stock");

    count = view.posted.length;
    const described = view.descriptions.length;
    view.presenter.activeDocumentChanged(undefined);
    view.presenter.activeDocumentChanged("file:///w/none.sql");
    view.presenter.activeDocumentChanged(UNTITLED_2);
    assert.equal(view.posted.length, count);
    assert.equal(view.descriptions.length, described);
    assert.deepEqual(view.presenter.replay(), bSequence);
    assert.equal(view.reveals, 2);
  });

  it("clears the view when the shown document closes, and drops a hidden one's record and answers", async () => {
    const { view } = await twoDocuments();
    view.presenter.activeDocumentChanged(FILE_A);
    view.presenter.runStarted(
      start({ queryId: "qc", documentUri: UNTITLED_2, documentLabel: "Untitled-2", connectionName: "stock" }),
    );
    view.presenter.activeDocumentChanged(FILE_A);

    let count = view.posted.length;
    view.presenter.documentClosed(UNTITLED_2);
    assert.equal(view.posted.length, count);
    view.presenter.activeDocumentChanged(UNTITLED_2);
    view.presenter.runSucceeded("qc", page([{ m: 2 }]));
    assert.equal(view.posted.length, count);
    assert.deepEqual(view.descriptions.at(-1), "a.sql on shop");

    view.presenter.documentClosed(FILE_A);
    assert.deepEqual(view.posted.slice(count), [{ v: 1, type: "clear" }]);
    assert.equal(view.descriptions.at(-1), undefined);
    assert.deepEqual(view.presenter.replay(), [{ v: 1, type: "clear" }]);

    count = view.posted.length;
    const described = view.descriptions.length;
    view.presenter.documentClosed(FILE_A);
    view.presenter.activeDocumentChanged(FILE_A);
    assert.equal(view.posted.length, count);
    assert.equal(view.descriptions.length, described);
  });

  it("moves a record to the saved document's URI, keeping its run, its answers and a read in flight", async () => {
    const view = answered();
    const before = view.presenter.replay();
    const read = view.presenter.loadMore(RUN_A);
    const count = view.posted.length;

    view.presenter.documentMoved(UNTITLED, "file:///w/q.sql");
    assert.equal(view.posted.length, count);
    assert.deepEqual(view.descriptions.at(-1), "q.sql on shop");
    const appended = page([{ n: 3 }], { limit: 2, offset: 2 });
    view.answers[0].resolve(appended);
    await read;
    assert.deepEqual(view.posted.at(-1), { v: 1, type: "pageAppended", runId: RUN_A, page: appended });
    assert.deepEqual(view.presenter.replay(), [
      ...before,
      { v: 1, type: "pageStarted", runId: RUN_A },
      view.posted.at(-1),
    ]);

    // The old key holds nothing now, and the new key's editor shows the moved record.
    view.presenter.activeDocumentChanged(UNTITLED);
    view.presenter.documentClosed(UNTITLED);
    assert.equal(view.presenter.replay()[0].type, "runStarted");
    const moved = setup();
    moved.presenter.runStarted(start({ queryId: "q7" }));
    moved.presenter.documentMoved(UNTITLED, "file:///w/q.sql");
    moved.presenter.runSucceeded("q7", page([{ n: 1 }]));
    assert.equal(moved.posted.at(-1)?.type, "runSucceeded");
    assert.deepEqual(moved.presenter.replay(), moved.posted);
  });

  it("moves a hidden record without touching the view, and the moved label shows when its editor is active", () => {
    const view = setup();
    view.presenter.runStarted(start({ queryId: "q1" }));
    view.presenter.runStarted(start({ queryId: "qa", documentUri: FILE_A, documentLabel: "a.sql" }));
    const count = view.posted.length;
    const described = view.descriptions.length;
    view.presenter.documentMoved(UNTITLED, "file:///w/q.sql");
    assert.equal(view.posted.length, count);
    assert.equal(view.descriptions.length, described);
    view.presenter.activeDocumentChanged("file:///w/q.sql");
    assert.deepEqual(view.descriptions.at(-1), "q.sql on shop");
    assert.equal((view.posted.at(-1) as { runId: string }).runId, RUN_A);
  });

  it("replaces the record a move lands on, showing the moved record when the replaced one was shown", () => {
    const view = setup();
    view.presenter.runStarted(start({ queryId: "q1" }));
    view.presenter.runStarted(start({ queryId: "qa", documentUri: "file:///w/q.sql", documentLabel: "q.sql" }));
    const count = view.posted.length;
    view.presenter.documentMoved(UNTITLED, "file:///w/q.sql");
    assert.deepEqual(view.posted.slice(count), [
      { v: 1, type: "runStarted", runId: RUN_A, statement: "select 1", startedAt: NOW },
    ]);
    assert.deepEqual(view.descriptions.at(-1), "q.sql on shop");
    view.presenter.runSucceeded("qa", page([{ n: 1 }]));
    assert.equal(view.posted.length, count + 1);
    assert.equal((view.presenter.replay()[0] as { runId: string }).runId, RUN_A);
  });
});
