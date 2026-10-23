import assert from "node:assert/strict";
import { BackendError, BackendExitedError } from "../../../src/host/backend-client";
import { LogResultsPresenter } from "../../../src/host/results/log-presenter";
import type { ResultsPresenter, RunStart } from "../../../src/host/results/results-presenter";
import type { QueryPage } from "../../../src/protocol";
import { ZERO_LEVELS } from "../../fakes/descriptions";
import { PG } from "../../fakes/profiles";

const STATEMENT_MARKER = "secret_column";
const ROW_MARKER = "row-value-marker";

const START: RunStart = {
  queryId: "q1",
  documentUri: "untitled:Untitled-1",
  documentLabel: "Untitled-1",
  connectionId: PG.id,
  connectionName: "shop",
  connectionType: "postgres",
  description: ZERO_LEVELS,
  statement: `select ${STATEMENT_MARKER} from t`,
  limit: 500,
};

function page(rows: Record<string, unknown>[]): QueryPage {
  return {
    rows,
    fields: ["v"],
    rowCount: rows.length,
    executionTime: 3,
    pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: rows.length, wasLimited: false },
  };
}

/** A presenter on a log that records `[level, message]` lines. */
function recorded(): { presenter: ResultsPresenter; lines: [string, string][] } {
  const lines: [string, string][] = [];
  const presenter = new LogResultsPresenter({
    info: (message: string) => lines.push(["info", message]),
    warn: (message: string) => lines.push(["warn", message]),
    error: (message: string | Error) => lines.push(["error", String(message)]),
  });
  return { presenter, lines };
}

describe("LogResultsPresenter", () => {
  let lines: [string, string][];
  let presenter: ResultsPresenter;

  beforeEach(() => {
    ({ presenter, lines } = recorded());
  });

  afterEach(() => {
    for (const [, message] of lines) {
      assert.ok(!message.includes(STATEMENT_MARKER), `a log line holds the statement: ${message}`);
      assert.ok(!message.includes(ROW_MARKER), `a log line holds a row value: ${message}`);
    }
  });

  it("writes one info line when a run starts, without the statement", () => {
    presenter.runStarted(START);
    assert.deepEqual(lines, [["info", "Run q1 started on Untitled-1 (shop)."]]);
  });

  it("writes the row count and time of a success, and no row value", () => {
    presenter.runSucceeded("q1", page([{ v: ROW_MARKER }, { v: ROW_MARKER }]));
    assert.deepEqual(lines, [["info", "Run q1 answered 2 rows in 3 ms."]]);
  });

  it("writes one row in the singular", () => {
    presenter.runSucceeded("q1", page([{ v: ROW_MARKER }]));
    assert.deepEqual(lines, [["info", "Run q1 answered 1 row in 3 ms."]]);
  });

  it("writes a cancelled run at warn, by its code", () => {
    presenter.runFailed("q1", new BackendError(499, "QUERY_CANCELLED", "Query was cancelled"));
    assert.deepEqual(lines, [["warn", "Run q1 was cancelled."]]);
  });

  it("writes a backend that stopped during the run at warn, with part 1's sentence", () => {
    presenter.runFailed("q1", new BackendExitedError({ exitCode: null, signal: "SIGKILL" }));
    assert.deepEqual(lines, [
      [
        "warn",
        "Run q1: The LibreDB backend stopped while this query ran (exit code none, signal SIGKILL). The statement may already have run on the server.",
      ],
    ]);
  });

  it("writes an exit code and a missing signal as the architecture does", () => {
    presenter.runFailed("q1", new BackendExitedError({ exitCode: 1, signal: null }));
    assert.deepEqual(lines, [
      [
        "warn",
        "Run q1: The LibreDB backend stopped while this query ran (exit code 1, signal none). The statement may already have run on the server.",
      ],
    ]);
  });

  it("writes any other backend error at error, with its message", () => {
    presenter.runFailed("q1", new BackendError(400, "QUERY_ERROR", 'relation "nope" does not exist'));
    assert.deepEqual(lines, [["error", 'Run q1 failed: relation "nope" does not exist']]);
  });

  it("writes a backend error whose message reads like a cancel at error, since it decides by code", () => {
    presenter.runFailed("q1", new BackendError(400, "QUERY_ERROR", "Query was cancelled"));
    assert.deepEqual(lines, [["error", "Run q1 failed: Query was cancelled"]]);
  });

  it("writes an unexpected error at error, with its stack", () => {
    const error = new TypeError("boom");
    presenter.runFailed("q1", error);
    assert.equal(lines.length, 1);
    const [level, message] = lines[0] ?? [];
    assert.equal(level, "error");
    assert.ok(message?.startsWith("Run q1 failed: boom"), message);
    assert.ok(error.stack !== undefined && message?.includes(error.stack), message);
  });

  it("writes a thrown value that is not an Error as text", () => {
    presenter.runFailed("q1", "plain text");
    assert.deepEqual(lines, [["error", "Run q1 failed: plain text"]]);
  });

  it("writes nothing when a document closes or moves", () => {
    presenter.documentClosed("untitled:Untitled-1");
    presenter.documentMoved("untitled:Untitled-1", "file:///w/q.sql");
    assert.deepEqual(lines, []);
  });
});
