import assert from "node:assert/strict";
import { BackendError, BackendExitedError } from "../../../src/host/backend-client";
import { toRunFailure } from "../../../src/host/results/failure";
import { parseHostMessage, type RunFailure } from "../../../src/results-protocol";
import { RUN_A } from "../../fixtures/results-sequences";

/** A log that records each error line, and every failure mapped through it. */
function recorded(): {
  log: { error(message: string | Error): void };
  lines: string[];
  map(error: unknown): RunFailure;
} {
  const lines: string[] = [];
  const log = { error: (message: string | Error) => lines.push(String(message)) };
  return {
    log,
    lines,
    map(error) {
      const failure = toRunFailure(error, log);
      // Every failure the mapping makes is one the webview's guard accepts as it is.
      parseHostMessage({ v: 1, type: "runFailed", runId: RUN_A, failure });
      return failure;
    },
  };
}

const MESSAGE = 'relation "nope" does not exist';

describe("toRunFailure", () => {
  it("maps QUERY_CANCELLED to cancelled and logs nothing", () => {
    const { map, lines } = recorded();
    assert.deepEqual(map(new BackendError(499, "QUERY_CANCELLED", "Query was cancelled")), { kind: "cancelled" });
    assert.deepEqual(lines, []);
  });

  it("maps a stopped backend to backendExited with its exit code and signal", () => {
    const { map, lines } = recorded();
    assert.deepEqual(map(new BackendExitedError({ exitCode: null, signal: "SIGKILL" })), {
      kind: "backendExited",
      exitCode: null,
      signal: "SIGKILL",
    });
    assert.deepEqual(map(new BackendExitedError({ exitCode: 1, signal: null })), {
      kind: "backendExited",
      exitCode: 1,
      signal: null,
    });
    assert.deepEqual(lines, []);
  });

  it("maps any other BackendError to an error with its message, its detail and its fix statement", () => {
    const { map, lines } = recorded();
    const error = new BackendError(400, "QUERY_ERROR", MESSAGE, {
      details: { position: 15, detail: "LINE 1: select * from nope" },
      fixStatement: "ROLLBACK;",
    });
    assert.deepEqual(map(error), {
      kind: "error",
      message: MESSAGE,
      detail: "LINE 1: select * from nope",
      fixStatement: "ROLLBACK;",
    });
    assert.deepEqual(lines, []);
  });

  it("holds no detail key unless details is an object whose detail is a string, and no fixStatement key unset", () => {
    const { map } = recorded();
    for (const details of [undefined, { position: 3 }, "text", { detail: 7 }, null, ["LINE 1"]]) {
      const failure = map(new BackendError(400, "QUERY_ERROR", MESSAGE, details === undefined ? {} : { details }));
      assert.deepEqual(failure, { kind: "error", message: MESSAGE });
      assert.deepEqual(Object.keys(failure), ["kind", "message"]);
    }
  });

  it("maps a BackendError with no code to an error with its message", () => {
    const { map } = recorded();
    assert.deepEqual(map(new BackendError(400, null, "Invalid params")), { kind: "error", message: "Invalid params" });
  });

  it("never decides by message text: a QUERY_ERROR saying it was cancelled is an error", () => {
    const { map } = recorded();
    assert.deepEqual(map(new BackendError(400, "QUERY_ERROR", "Query was cancelled")), {
      kind: "error",
      message: "Query was cancelled",
    });
  });

  it("maps anything else to an error with its message, and logs it with its stack", () => {
    const { map, lines } = recorded();
    const boom = new TypeError("boom");
    assert.deepEqual(map(boom), { kind: "error", message: "boom" });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("boom"));
    assert.ok(lines[0].includes(String(boom.stack)));

    assert.deepEqual(map("bare"), { kind: "error", message: "bare" });
    assert.equal(lines.length, 2);
    assert.ok(lines[1].includes("bare"));
  });

  it("logs nothing without a log, since a run's failure is logged by the log presenter", () => {
    assert.deepEqual(toRunFailure(new TypeError("boom")), { kind: "error", message: "boom" });
    assert.deepEqual(toRunFailure("bare"), { kind: "error", message: "bare" });
  });
});
