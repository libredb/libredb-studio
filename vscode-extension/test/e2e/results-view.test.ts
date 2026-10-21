// The Results view in a real extension host against PostgreSQL in Docker (part 4 criteria 8, 12's host half, 13 and
// 14): what the host posts, what the real webview sends and the view's description are read through host-capture.ts,
// and a Load More or a copy reaches the host through the capture's send, as the webview's own postMessage would.
// It needs Docker, so it stays out of the smoke subset.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { CONTEXT_KEYS, RESULTS_VIEW } from "../../src/host/names";
import { psql, type RunningEngine, START_DEADLINE_MS, startEngine, stopEngine } from "../integration/containers";
import { engineFixture } from "../integration/engines";
import { hostCapture, installHostCapture } from "./host-capture";

const EXTENSION_ID = "libredb.libredb-studio";
const execFileAsync = promisify(execFile);

installHostCapture();

const settings = () => vscode.workspace.getConfiguration("libredb");

/** Polls the condition every 25 ms and fails with the message once ms have passed. */
async function waitFor(condition: () => boolean, ms: number, message: () => string): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) assert.fail(`${message()} within ${ms} ms`);
    await delay(25);
  }
}

/** pg_isready over TCP inside the container: the image's first, socket-only server does not answer it. */
async function waitForPostgres(engine: RunningEngine): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await execFileAsync("docker", ["exec", engine.containerId, "pg_isready", "-h", "127.0.0.1", "-q"]);
      return;
    } catch (error) {
      if (Date.now() - started > START_DEADLINE_MS) throw error;
    }
    await delay(500);
  }
}

interface Message {
  readonly type: string;
  readonly runId?: string;
  readonly page?: { rows: Record<string, unknown>[]; pagination: { hasMore: boolean } };
  readonly [key: string]: unknown;
}

const typesOf = (messages: readonly unknown[]): string[] => messages.map((message) => (message as Message).type);
const isReady = (raw: unknown): boolean => (raw as Message).type === "ready";

describe("the LibreDB Results view in a real extension host against PostgreSQL", () => {
  const runId = `${process.pid}-${Date.now()}`;
  const pgId = `pr13pg-${runId}`;
  const pgName = "e2e results pg";
  const fixture = engineFixture("postgres");
  let pg: RunningEngine | undefined;
  let savedConnections: unknown;
  let savedRowLimit: unknown;
  const capture = hostCapture();
  const results = capture.results();
  const window = vscode.window as {
    -readonly [K in "showQuickPick" | "showInputBox"]: (typeof vscode.window)[K];
  };
  const originals = { showQuickPick: window.showQuickPick, showInputBox: window.showInputBox };

  const engine = (): RunningEngine => {
    assert.ok(pg, "PostgreSQL is not running");
    return pg;
  };

  /** New Query from the palette on the PostgreSQL connection, holding the text; answers the shown editor. */
  async function newQuery(text: string): Promise<vscode.TextEditor> {
    await vscode.commands.executeCommand("libredb.newQuery");
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, "New Query showed no editor");
    const whole = new vscode.Range(0, 0, editor.document.lineCount, 0);
    assert.ok(await editor.edit((builder) => builder.replace(whole, text)));
    return editor;
  }

  /** Runs the active editor's text, and answers what the host posted for it. */
  async function run(): Promise<Message[]> {
    const from = results.posted.length;
    await vscode.commands.executeCommand("libredb.runQuery");
    return results.posted.slice(from) as Message[];
  }

  /** Waits until the posted messages from `from` on hold `count`, and answers them. */
  async function postedSince(from: number, count: number, what: string): Promise<Message[]> {
    await waitFor(
      () => results.posted.length >= from + count,
      10_000,
      () => `${what}: posted ${JSON.stringify(typesOf(results.posted.slice(from)))}`,
    );
    return results.posted.slice(from) as Message[];
  }

  /** Shows the view and waits for the real webview's next ready, answered by init and the replay. */
  async function readyAfter(show: () => Promise<void>): Promise<Message[]> {
    const received = results.received.length;
    const posted = results.posted.length;
    await show();
    await waitFor(
      () => results.received.slice(received).some(isReady),
      20_000,
      () => `no ready from the view: received ${JSON.stringify(results.received.slice(received))}`,
    );
    // The replay is posted in the same turn as init; a short wait lets nothing more arrive.
    await delay(250);
    return results.posted.slice(posted) as Message[];
  }

  const focusView = () => vscode.commands.executeCommand(`${RESULTS_VIEW}.focus`) as Promise<void>;

  /** Reverts and closes the active editor. */
  const closeActive = () => vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");

  before(async function () {
    this.timeout(START_DEADLINE_MS * 2 + 120_000);
    savedConnections = settings().inspect("connections")?.globalValue;
    savedRowLimit = settings().inspect("query.rowLimit")?.globalValue;
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not loaded in the test instance`);
    await extension.activate();
    pg = await startEngine("postgres", runId, extension.extensionPath);
    await waitForPostgres(pg);
    for (const statement of fixture.setup) await psql(pg, statement);
    const connection = fixture.connection(pg, pgId, { name: pgName });
    // The password is the input box's answer, never the setting's.
    const { password, ...entry } = connection;
    assert.ok(password);
    await settings().update(
      "connections",
      [{ ...entry, secretFields: ["password"] }],
      vscode.ConfigurationTarget.Global,
    );
    await settings().update("query.rowLimit", 2, vscode.ConfigurationTarget.Global);
    // The view is shown and its webview ready before any run, so every message the host posts reaches it.
    await readyAfter(focusView);
  });

  beforeEach(() => {
    window.showQuickPick = (async (
      items: readonly vscode.QuickPickItem[] | Thenable<readonly vscode.QuickPickItem[]>,
    ) => (await items).find((item) => item.label === pgName)) as unknown as typeof vscode.window.showQuickPick;
    window.showInputBox = (() =>
      Promise.resolve(engine().environment.POSTGRES_PASSWORD)) as typeof vscode.window.showInputBox;
  });

  afterEach(async () => {
    Object.assign(window, originals);
    let closed = 0;
    for (; vscode.window.activeTextEditor !== undefined && closed < 50; closed += 1) await closeActive();
    if (closed > 0) await delay(1200);
  });

  after(async function () {
    this.timeout(120_000);
    try {
      await settings().update("connections", savedConnections, vscode.ConfigurationTarget.Global);
      await settings().update("query.rowLimit", savedRowLimit, vscode.ConfigurationTarget.Global);
    } finally {
      if (pg !== undefined) await stopEngine(pg);
      pg = undefined;
    }
  });

  it("pages a run by Load More, a read under the document's key that logs no run start (criterion 8)", async function () {
    this.timeout(120_000);
    const editor = await newQuery(fixture.selectFour);
    const uri = editor.document.uri.toString();
    const logFrom = capture.logLines.length;
    const first = await run();
    assert.deepEqual(typesOf(first), ["runStarted", "runSucceeded"], JSON.stringify(first));
    const { runId: id, page } = first[1];
    assert.ok(id !== undefined && page !== undefined);
    assert.deepEqual(
      page.rows.map((row) => row.n),
      [1, 2],
    );
    assert.equal(page.pagination.hasMore, true);

    const contextFrom = capture.contexts.length;
    const postedFrom = results.posted.length;
    const started = Date.now();
    results.send({ v: 1, type: "loadMore", runId: id });
    const more = await postedSince(postedFrom, 2, "Load More");
    console.log(`VS Code ${vscode.version}: the page read answered in ${Date.now() - started} ms`);
    assert.deepEqual(typesOf(more), ["pageStarted", "pageAppended"], JSON.stringify(more));
    assert.deepEqual(
      more[1].page?.rows.map((row) => row.n),
      [3, 4],
    );
    assert.equal(more[1].page?.pagination.hasMore, false);
    const held = capture.contexts
      .slice(contextFrom)
      .some((context) => context.key === CONTEXT_KEYS.runningQueries && (context.value as string[]).includes(uri));
    assert.ok(held, "libredb.runningQueries never held the document while the page read ran");
    const starts = capture.logLines.slice(logFrom).filter((line) => /^Run \S+ started on /.test(line));
    assert.equal(starts.length, 1, starts.join("\n"));
  });

  it("shows the active editor's record, named in the description, and clears when its document closes (criterion 14)", async function () {
    this.timeout(120_000);
    const a = await newQuery("select 1 as a");
    const aRun = await run();
    assert.deepEqual(typesOf(aRun), ["runStarted", "runSucceeded"], JSON.stringify(aRun));
    const b = await newQuery("select 2 as b");
    assert.deepEqual(typesOf(await run()), ["runStarted", "runSucceeded"]);
    const label = (editor: vscode.TextEditor) => editor.document.uri.path.split("/").at(-1);
    assert.equal(results.description, `${label(b)} on ${pgName}`);

    const from = results.posted.length;
    await vscode.window.showTextDocument(a.document);
    const shown = await postedSince(from, 2, "showing A");
    assert.deepEqual(shown, aRun);
    assert.match(results.description ?? "", /^Untitled-\d+ on /);
    assert.equal(results.description, `${label(a)} on ${pgName}`);

    // Closing A while B is open makes B active, and B's record is shown: the view clears only when the editor left
    // active holds no record. Closing B, a dirty untitled document, from elsewhere activates it for its save prompt,
    // so B is shown and closed, which shows A again, and A, the last editor, closes after it.
    const showingB = results.posted.length;
    await vscode.window.showTextDocument(b.document);
    await postedSince(showingB, 2, "showing B");
    const closingB = results.posted.length;
    await closeActive();
    assert.deepEqual(await postedSince(closingB, 2, "closing B"), aRun);
    await delay(1500);
    assert.deepEqual(results.posted.slice(closingB + 2), [], "B's close, past its grace, posted");
    assert.equal(results.description, `${label(a)} on ${pgName}`);
    const closing = results.posted.length;
    await closeActive();
    const cleared = await postedSince(closing, 1, "closing A");
    assert.deepEqual(cleared, [{ v: 1, type: "clear" }]);
    assert.equal(results.description, undefined);
  });

  it("replays the current record to a view that reloads after the panel closes or toggles (criterion 13)", async function () {
    this.timeout(120_000);
    await newQuery(fixture.selectFour);
    const live = await run();
    assert.deepEqual(typesOf(live), ["runStarted", "runSucceeded"]);
    const postedFrom = results.posted.length;
    results.send({ v: 1, type: "loadMore", runId: live[1].runId });
    live.push(...(await postedSince(postedFrom, 2, "Load More")));
    const init = {
      v: 1,
      type: "init",
      theme: (results.posted.findLast((m) => (m as Message).type === "init") as Message).theme,
    };

    const reopened = await readyAfter(async () => {
      await vscode.commands.executeCommand("workbench.action.closePanel");
      await focusView();
    });
    assert.deepEqual(reopened, [init, ...live]);

    const toggled = await readyAfter(async () => {
      await vscode.commands.executeCommand("workbench.action.togglePanel");
      await vscode.commands.executeCommand("workbench.action.togglePanel");
    });
    assert.deepEqual(toggled, [init, ...live]);
  });

  it("writes a copy to the system clipboard and answers copied (criterion 12, the host half)", async function () {
    this.timeout(60_000);
    const text = "ada@example.com";
    const from = results.posted.length;
    const receivedFrom = results.received.length;
    results.send({ v: 1, type: "copy", requestId: 1, text });
    const answered = await postedSince(from, 1, "the copy");
    assert.deepEqual(answered, [{ v: 1, type: "copied", requestId: 1, ok: true }]);
    const read = await vscode.env.clipboard.readText();
    console.log(`VS Code ${vscode.version}: the clipboard reads back ${JSON.stringify(read)}`);
    assert.equal(read, text);
    // The real webview made no copy request 1, so it reports the answer it was handed: proof that copied reached it.
    await waitFor(
      () => results.received.length > receivedFrom,
      5000,
      () => "the webview sent nothing after copied",
    );
    assert.deepEqual(results.received.slice(receivedFrom), [
      { v: 1, type: "reportError", message: "The host settled copy request 1, which this view never made." },
    ]);
  });
});
