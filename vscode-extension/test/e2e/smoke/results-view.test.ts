// The Results view resolves in a real extension host with no backend (part 4 criterion 2): the real bundle loads under
// the view's real CSP, since only its script posts ready, and the host answers with init and clear. It needs no Docker,
// so it is in the smoke subset that runs on macOS and Windows too.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { RESULTS_VIEW } from "../../../src/host/names";
import { hostCapture, installHostCapture } from "../host-capture";

const EXTENSION_ID = "libredb.libredb-studio";
const execFileAsync = promisify(execFile);

installHostCapture();

/** The supervisor's line for every child it forks. */
const STARTING = /^Starting the LibreDB backend /;

/**
 * The command lines of this extension host's children that run dist/backend.js, from ps, which answers --ppid on
 * Linux only; undefined on every other platform, where the log's Starting lines are the evidence.
 */
async function backendChildren(): Promise<string[] | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "args=", "--ppid", String(process.pid)]);
    return stdout.split("\n").filter((line) => line.includes("dist/backend.js"));
  } catch (error) {
    // ps exits 1, printing nothing, when the process has no children at all.
    if ((error as { code?: unknown; stdout?: unknown }).code === 1 && (error as { stdout?: unknown }).stdout === "") {
      return [];
    }
    throw error;
  }
}

const isReady = (raw: unknown): boolean =>
  typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "ready";
const typeOf = (raw: unknown): unknown => (raw as { type?: unknown }).type;

describe("the LibreDB Results view in a real extension host", () => {
  it("resolves with init and clear for the real webview's ready, and forks no backend (criterion 2)", async function () {
    this.timeout(60_000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not loaded in the test instance`);
    await extension.activate();
    const capture = hostCapture();
    const results = capture.results();
    const children = await backendChildren();
    const starts = capture.logLines.filter((line) => STARTING.test(line)).length;
    const resolves = results.resolves;
    const received = results.received.length;
    const posted = results.posted.length;

    // In the full leg the Docker cases resolved the view before this one: a closed panel reloads it on the focus.
    const fresh = resolves === 0;
    await vscode.commands.executeCommand("workbench.action.closePanel");
    await vscode.commands.executeCommand(`${RESULTS_VIEW}.focus`);
    const started = Date.now();
    while (!results.received.slice(received).some(isReady)) {
      if (Date.now() - started > 20_000) {
        assert.fail(
          `no ready within 20 s: ${results.resolves - resolves} resolves, received ${JSON.stringify(results.received.slice(received))}`,
        );
      }
      await delay(50);
    }
    console.log(`VS Code ${vscode.version}: the Results view sent ready ${Date.now() - started} ms after its focus`);
    // The host answers the ready at once; a few ms let its posts land in the capture.
    const answered = Date.now();
    while (results.posted.length < posted + 2 && Date.now() - answered < 5000) await delay(25);
    assert.equal(typeOf(results.posted[posted]), "init");
    if (fresh) {
      assert.equal(results.resolves, 1);
      assert.deepEqual(results.posted.slice(posted).map(typeOf), ["init", "clear"]);
    }
    assert.equal((results.posted[posted] as { theme?: unknown }).theme !== undefined, true, "init carries no theme");
    assert.deepEqual(
      results.received.slice(received).filter((raw) => typeOf(raw) === "reportError"),
      [],
    );
    assert.equal(capture.logLines.filter((line) => STARTING.test(line)).length, starts, "the view started a backend");
    assert.deepEqual(await backendChildren(), children);
  });
});
