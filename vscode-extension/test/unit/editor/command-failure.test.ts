import assert from "node:assert/strict";
import { BackendError, BackendExitedError } from "../../../src/host/backend-client";
import { CredentialsNotGivenError } from "../../../src/host/connections/connection-source";
import { reportCommandFailure } from "../../../src/host/editor/command-failure";
import { answerMessages, shownMessages, window } from "../../fakes/vscode";

/** reportCommandFailure's deps over the fake window, with the log lines and Show Log runs it caused. */
function setup() {
  const lines: string[] = [];
  let logsShown = 0;
  const deps = {
    window,
    log: { error: (line: string | Error) => lines.push(String(line)) },
    showLog: () => {
      logsShown += 1;
      return Promise.resolve();
    },
  };
  return { deps, lines, logsShown: () => logsShown };
}

/** Lets the message's answer reach its handler. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("reportCommandFailure", () => {
  it("shows nothing and logs nothing for a declined secret prompt", async () => {
    const { deps, lines } = setup();
    reportCommandFailure(deps, new CredentialsNotGivenError("shop"));
    await settle();
    assert.deepEqual(shownMessages, []);
    assert.deepEqual(lines, []);
  });

  it("shows the refused open's message when Enter Credentials was declined", async () => {
    const { deps, lines } = setup();
    const refusal = new BackendError(503, "CONNECTION_ERROR", 'database "nope" does not exist');
    reportCommandFailure(deps, new CredentialsNotGivenError("shop", refusal));
    await settle();
    assert.deepEqual(shownMessages, [
      { level: "error", message: 'database "nope" does not exist', items: ["Show Log"] },
    ]);
    assert.deepEqual(lines, []);
  });

  it("shows a backend error's sentence with Show Log, which shows the log once", async () => {
    const { deps, lines, logsShown } = setup();
    answerMessages(() => "Show Log");
    reportCommandFailure(deps, new BackendError(500, "CONNECTION_ERROR", "connect ECONNREFUSED 127.0.0.1:5432"));
    await settle();
    assert.deepEqual(shownMessages, [
      { level: "error", message: "connect ECONNREFUSED 127.0.0.1:5432", items: ["Show Log"] },
    ]);
    assert.equal(logsShown(), 1);
    assert.deepEqual(lines, []);
  });

  it("does not show the log when the message is dismissed", async () => {
    const { deps, logsShown } = setup();
    reportCommandFailure(deps, new BackendError(500, "CONNECTION_ERROR", "refused"));
    await settle();
    assert.equal(logsShown(), 0);
  });

  it("shows a lost backend's own message with Show Log", async () => {
    const { deps, lines } = setup();
    const error = new BackendExitedError({ exitCode: 1, signal: null });
    reportCommandFailure(deps, error);
    await settle();
    assert.deepEqual(shownMessages, [{ level: "error", message: error.message, items: ["Show Log"] }]);
    assert.deepEqual(lines, []);
  });

  it("shows any other error's message and logs its stack", async () => {
    const { deps, lines } = setup();
    const error = new TypeError("boom");
    reportCommandFailure(deps, error);
    await settle();
    assert.deepEqual(shownMessages, [{ level: "error", message: "boom", items: ["Show Log"] }]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes(error.stack as string));
  });

  it("shows a thrown value that is not an Error as text", async () => {
    const { deps, lines } = setup();
    reportCommandFailure(deps, "x");
    await settle();
    assert.deepEqual(shownMessages, [{ level: "error", message: "x", items: ["Show Log"] }]);
    assert.deepEqual(lines, []);
  });
});
