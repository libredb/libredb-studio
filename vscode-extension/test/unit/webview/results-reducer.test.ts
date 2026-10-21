import assert from "node:assert/strict";
import type { QueryPage } from "../../../src/protocol";
import type { GridContext, HostToWebview, RunFailure, ThemeKind } from "../../../src/results-protocol";
import {
  INITIAL_RESULTS_STATE,
  pageToResult,
  type ResultsState,
  resultsReducer,
} from "../../../src/webview/results-reducer";

const A = "6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4";
const B = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const GRID: GridContext = { databaseType: "postgres", supportsResultPagination: true, commitKeyword: "COMMIT" };

function pg(rows: Record<string, unknown>[], more: boolean, offset = 0): QueryPage {
  return {
    rows,
    fields: ["n"],
    rowCount: rows.length,
    executionTime: 4,
    pagination: { limit: 2, offset, hasMore: more, totalReturned: rows.length, wasLimited: more },
  };
}

const play = (...messages: HostToWebview[]): ResultsState => messages.reduce(resultsReducer, INITIAL_RESULTS_STATE);

const started = (runId = A): HostToWebview => ({
  v: 1,
  type: "runStarted",
  runId,
  statement: "select n from t",
  startedAt: 1000,
});
const succeeded = (page = pg([{ n: 1 }, { n: 2 }], true), runId = A): HostToWebview => ({
  v: 1,
  type: "runSucceeded",
  runId,
  page,
  grid: GRID,
});
const appended = (page: QueryPage, runId = A): HostToWebview => ({ v: 1, type: "pageAppended", runId, page });
const pageStarted = (runId = A): HostToWebview => ({ v: 1, type: "pageStarted", runId });
const pageFailed = (failure: RunFailure, runId = A): HostToWebview => ({ v: 1, type: "pageFailed", runId, failure });

function rows(state: ResultsState) {
  assert.equal(state.view.kind, "rows");
  if (state.view.kind !== "rows") throw new Error("unreachable");
  return state.view;
}

describe("the results reducer", () => {
  it("starts with no theme and the empty view", () => {
    assert.deepEqual(INITIAL_RESULTS_STATE, { theme: null, view: { kind: "empty" } });
  });

  it("a run's live sequence ends with its rows, appended page by page", () => {
    const state = play(started(), succeeded(), pageStarted(), appended(pg([{ n: 3 }, { n: 4 }], false, 2)));
    const view = rows(state);
    assert.deepEqual(view.result.rows, [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
    assert.equal(view.result.rowCount, 4);
    assert.equal(view.result.pagination?.hasMore, false);
    assert.equal(view.loadingMore, false);
    assert.equal(view.statement, "select n from t");
    assert.equal(view.runId, A);
    assert.deepEqual(view.grid, GRID);
  });

  it("shows the running state with the statement and its start", () => {
    assert.deepEqual(play(started()).view, {
      kind: "running",
      runId: A,
      statement: "select n from t",
      startedAt: 1000,
    });
  });

  it("carries the first page's count and pagination, then the merged count and the last page's (criterion 8)", () => {
    const first = pg([{ n: 1 }, { n: 2 }], true);
    const afterFirst = rows(play(started(), succeeded(first)));
    assert.equal(afterFirst.result.rowCount, 2);
    assert.deepEqual(afterFirst.result.pagination, first.pagination);
    assert.equal(afterFirst.loadingMore, false);
    assert.equal("pageFailure" in afterFirst, false);
    const last = pg([{ n: 3 }, { n: 4 }], false, 2);
    const afterAppend = rows(play(started(), succeeded(first), pageStarted(), appended(last)));
    assert.equal(afterAppend.result.rowCount, 4);
    assert.deepEqual(afterAppend.result.pagination, last.pagination);
  });

  it("appends through appendResultPage: an empty page keeps the fields, vector columns follow the page or carry", () => {
    const empty: QueryPage = { ...pg([], false, 2), fields: [] };
    assert.deepEqual(rows(play(started(), succeeded(), appended(empty))).result.fields, ["n"]);

    const v1 = { n: { kind: "dense" as const, dtype: "float32" as const, dimension: 3 } };
    const v2 = { n: { kind: "dense" as const, dtype: "float64" as const, dimension: 3 } };
    const first = { ...pg([{ n: 1 }], true), vectorColumns: v1 };
    assert.deepEqual(
      rows(play(started(), succeeded(first), appended({ ...pg([{ n: 2 }], false, 1), vectorColumns: v2 }))).result
        .vectorColumns,
      v2,
    );
    assert.deepEqual(
      rows(play(started(), succeeded(first), appended(pg([{ n: 2 }], false, 1)))).result.vectorColumns,
      v1,
    );
  });

  it("builds the grid's result without openTransaction and resultSetCount, and keeps the first page's on the view", () => {
    const first: QueryPage = { ...pg([{ n: 1 }], true), openTransaction: "rolled-back", resultSetCount: 2 };
    const result = pageToResult(first);
    assert.equal(Object.hasOwn(result, "openTransaction"), false);
    assert.equal(Object.hasOwn(result, "resultSetCount"), false);
    assert.deepEqual(result, pg([{ n: 1 }], true));
    assert.deepEqual(first.resultSetCount, 2, "the page itself is not changed");

    const view = rows(play(started(), succeeded(first)));
    assert.equal(view.openTransaction, "rolled-back");
    assert.equal(view.resultSetCount, 2);
    assert.equal(Object.hasOwn(view.result, "resultSetCount"), false);

    const later = rows(play(started(), succeeded(first), appended({ ...pg([{ n: 2 }], false, 1), resultSetCount: 3 })));
    assert.equal(later.openTransaction, "rolled-back");
    assert.equal(later.resultSetCount, 2);
    assert.equal(Object.hasOwn(later.result, "resultSetCount"), false);

    const plain = rows(play(started(), succeeded()));
    assert.equal(Object.hasOwn(plain, "openTransaction"), false);
    assert.equal(Object.hasOwn(plain, "resultSetCount"), false);
  });

  it("keeps the rows when a page fails, and clears the failure when the next read starts", () => {
    const failure: RunFailure = { kind: "error", message: "connection reset" };
    const failed = rows(
      play(
        started(),
        succeeded(),
        pageStarted(),
        appended(pg([{ n: 3 }, { n: 4 }], true, 2)),
        pageStarted(),
        pageFailed(failure),
      ),
    );
    assert.equal(failed.result.rows.length, 4);
    assert.deepEqual(failed.pageFailure, failure);
    assert.equal(failed.loadingMore, false);

    const retried = rows(play(started(), succeeded(), pageStarted(), pageFailed(failure), pageStarted()));
    assert.equal("pageFailure" in retried, false);
    assert.equal(retried.loadingMore, true);

    const recovered = rows(
      play(started(), succeeded(), pageStarted(), pageFailed(failure), appended(pg([{ n: 3 }], false, 2))),
    );
    assert.equal("pageFailure" in recovered, false);
  });

  for (const failure of [
    { kind: "error", message: "boom", detail: "d", fixStatement: "f" },
    { kind: "cancelled" },
    { kind: "backendExited", exitCode: null, signal: "SIGKILL" },
  ] satisfies RunFailure[]) {
    it(`shows a ${failure.kind} run failure with its statement`, () => {
      assert.deepEqual(play(started(), { v: 1, type: "runFailed", runId: A, failure }).view, {
        kind: "failed",
        runId: A,
        statement: "select n from t",
        failure,
      });
    });
  }

  it("drops every run message for another run, and lets runStarted replace the run", () => {
    const shown = play(started(), succeeded());
    for (const message of [
      succeeded(pg([{ n: 9 }], false), B),
      { v: 1, type: "runFailed", runId: B, failure: { kind: "cancelled" } },
      pageStarted(B),
      appended(pg([{ n: 9 }], false), B),
      pageFailed({ kind: "cancelled" }, B),
    ] satisfies HostToWebview[]) {
      assert.equal(resultsReducer(shown, message), shown, message.type);
    }
    const running = play(started(), succeeded(), started(B));
    assert.equal(running.view.kind === "running" && running.view.runId, B);
    assert.equal(resultsReducer(running, succeeded(pg([{ n: 1 }], false), A)), running);
    const failedRun = play(started(), { v: 1, type: "runFailed", runId: A, failure: { kind: "cancelled" } });
    assert.equal(
      play(started(), { v: 1, type: "runFailed", runId: A, failure: { kind: "cancelled" } }, started(B)).view.kind,
      "running",
    );
    assert.equal(resultsReducer(failedRun, pageStarted()), failedRun);
  });

  it("changes nothing for a message out of order", () => {
    const empty = INITIAL_RESULTS_STATE;
    assert.equal(resultsReducer(empty, succeeded()), empty);
    assert.equal(resultsReducer(empty, pageStarted()), empty);
    const running = play(started());
    assert.equal(resultsReducer(running, appended(pg([{ n: 3 }], false))), running);
    assert.equal(resultsReducer(running, pageStarted()), running);
    assert.equal(resultsReducer(running, pageFailed({ kind: "cancelled" })), running);
    const shown = play(started(), succeeded());
    assert.equal(resultsReducer(shown, succeeded()), shown);
    assert.equal(resultsReducer(shown, { v: 1, type: "runFailed", runId: A, failure: { kind: "cancelled" } }), shown);
  });

  it("sets each theme kind on init and theme, and leaves the view", () => {
    const shown = play(started(), succeeded());
    for (const theme of ["light", "dark", "highContrast", "highContrastLight"] satisfies ThemeKind[]) {
      for (const type of ["init", "theme"] as const) {
        const next = resultsReducer(shown, { v: 1, type, theme });
        assert.equal(next.theme, theme);
        assert.equal(next.view, shown.view);
      }
    }
    const themed = resultsReducer(shown, { v: 1, type: "theme", theme: "dark" });
    assert.equal(resultsReducer(themed, { v: 1, type: "theme", theme: "dark" }), themed);
  });

  it("empties the view on clear, and ignores copied", () => {
    const shown = play(started(), succeeded());
    assert.deepEqual(resultsReducer(shown, { v: 1, type: "clear" }).view, { kind: "empty" });
    assert.equal(resultsReducer(INITIAL_RESULTS_STATE, { v: 1, type: "clear" }), INITIAL_RESULTS_STATE);
    assert.equal(resultsReducer(shown, { v: 1, type: "copied", requestId: 0, ok: true }), shown);
  });

  it("reaches the live run's state from Part H's replay of a succeeded record", () => {
    const failure: RunFailure = { kind: "cancelled" };
    const second = pg([{ n: 3 }, { n: 4 }], true, 2);
    const live = play(
      { v: 1, type: "init", theme: "dark" },
      started(),
      succeeded(),
      pageStarted(),
      appended(second),
      pageStarted(),
      pageFailed(failure),
    );
    const replay = play(
      { v: 1, type: "init", theme: "dark" },
      started(),
      succeeded(),
      appended(second),
      pageFailed(failure),
    );
    assert.deepEqual(replay, live);
  });

  it("does not change the state it was given", () => {
    const shown = play(started(), succeeded());
    const before = JSON.parse(JSON.stringify(shown));
    resultsReducer(shown, appended(pg([{ n: 3 }], false, 2)));
    assert.deepEqual(shown, before);
  });
});
