// Editors, Run and Cancel in a real extension host (part 3 criteria 14 and 16 to 20, the unbound half of 21, and part
// 2 criterion 19's run half): the context keys, the status bar item and the LibreDB log are read through
// host-capture.ts, the pickers and notifications through replaced window functions. It needs Docker, so it stays out
// of the smoke subset.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { CHANGE_REFUSED } from "../../src/host/editor/commands";
import { CONTEXT_KEYS } from "../../src/host/names";
import { TEST_PASSWORD } from "../fakes/credentials";
import { psql, type RunningEngine, START_DEADLINE_MS, startEngine, stopEngine } from "../integration/containers";
import { contextValue, hostCapture, installHostCapture } from "./host-capture";
import { connectionsTree, installTreeCapture } from "./tree-capture";

const EXTENSION_ID = "libredb.libredb-studio";
const execFileAsync = promisify(execFile);

installHostCapture();
installTreeCapture();

async function activated(): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not loaded in the test instance`);
  await extension.activate();
  return extension;
}

const settings = () => vscode.workspace.getConfiguration("libredb");
const savedConnections = (): readonly Record<string, unknown>[] =>
  settings().get<Record<string, unknown>[]>("connections") ?? [];

/** Polls the condition every 25 ms and fails with the message once ms have passed. */
async function waitFor(condition: () => boolean, ms: number, message: () => string): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) assert.fail(`${message()} within ${ms} ms`);
    await delay(25);
  }
}

const keyHolds = (key: string, uri: string): boolean => {
  try {
    return contextValue(key).includes(uri);
  } catch {
    return false;
  }
};
const keys = (uri: string) => JSON.stringify(Object.values(CONTEXT_KEYS).filter((key) => keyHolds(key, uri)));

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

describe("editors, Run and Cancel in a real extension host", () => {
  const runId = `${process.pid}-${Date.now()}`;
  const pgId = `pr11pg-${runId}`;
  const pgServerId = `pr11pgs-${runId}`;
  const mongoId = `pr11mg-${runId}`;
  const names: Record<string, string> = {
    [pgId]: "e2e pg",
    [pgServerId]: "e2e pg server",
    [mongoId]: "e2e mongo",
  };
  let pg: RunningEngine | undefined;
  let mongo: RunningEngine | undefined;
  let saved: unknown;
  let folder: string;
  /** The secret each connection's box answers, by its name. */
  const secrets = new Map<string, string>();
  /** What the next showQuickPick answers: the label to choose, or undefined to dismiss. */
  let pickAnswers: (string | undefined)[] = [];
  let picks: vscode.QuickPickItem[][] = [];
  let warnings: string[] = [];
  let warningAnswer: string | undefined;
  let errors: string[] = [];
  const window = vscode.window as {
    -readonly [K in
      | "showQuickPick"
      | "showInputBox"
      | "showWarningMessage"
      | "showErrorMessage"]: (typeof vscode.window)[K];
  };
  const originals = {
    showQuickPick: window.showQuickPick,
    showInputBox: window.showInputBox,
    showWarningMessage: window.showWarningMessage,
    showErrorMessage: window.showErrorMessage,
  };
  const capture = hostCapture();

  const engine = (running: RunningEngine | undefined): RunningEngine => {
    assert.ok(running, "an engine is not running");
    return running;
  };

  /** Runs the command on the active editor and answers the log lines it wrote. */
  async function runActive(): Promise<string[]> {
    const from = capture.logLines.length;
    await vscode.commands.executeCommand("libredb.runQuery");
    return capture.logLines.slice(from);
  }

  /** New Query from the palette on the connection, its catalog picked when asked; answers the shown editor. */
  async function newQuery(connectionId: string, catalog?: string): Promise<vscode.TextEditor> {
    pickAnswers = [names[connectionId], ...(catalog === undefined ? [] : [catalog])];
    await vscode.commands.executeCommand("libredb.newQuery");
    assert.deepEqual(pickAnswers, [], "New Query did not show every pick");
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, "New Query showed no editor");
    return editor;
  }

  async function setText(editor: vscode.TextEditor, text: string): Promise<void> {
    const whole = new vscode.Range(0, 0, editor.document.lineCount, 0);
    assert.ok(await editor.edit((builder) => builder.replace(whole, text)));
  }

  /** Reverts and closes the active editor. */
  const closeActive = () => vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");

  /** A run of `select pg_sleep(30)` on a new PostgreSQL editor, once its statement is sent. */
  async function sleeping(): Promise<{ editor: vscode.TextEditor; uri: string; run: Thenable<unknown> }> {
    const editor = await newQuery(pgId);
    await setText(editor, "select pg_sleep(30)");
    const uri = editor.document.uri.toString();
    const from = capture.logLines.length;
    const run = vscode.commands.executeCommand("libredb.runQuery");
    await waitFor(
      () => startedSince(from) && keyHolds(CONTEXT_KEYS.runningQueries, uri),
      5000,
      () => `the run of ${uri} did not start`,
    );
    await delay(500);
    return { editor, uri, run };
  }

  /** Waits for the thenable, failing after ms; answers the time it took. */
  async function settlesWithin(thenable: Thenable<unknown>, ms: number, what: string): Promise<number> {
    const started = Date.now();
    const settled = await Promise.race([Promise.resolve(thenable).then(() => true), delay(ms).then(() => false)]);
    const elapsed = Date.now() - started;
    assert.ok(settled, `${what} had not settled after ${ms} ms`);
    return elapsed;
  }

  const startedSince = (from: number) => capture.logLines.slice(from).some((line) => /^Run \S+ started on /.test(line));

  const cancelledLine = (lines: readonly string[]) => lines.find((line) => /^Run \S+ was cancelled\.$/.test(line));

  before(async function () {
    this.timeout(START_DEADLINE_MS * 2 + 120_000);
    saved = settings().inspect("connections")?.globalValue;
    await settings().update("connections", [], vscode.ConfigurationTarget.Global);
    const { extensionPath } = await activated();
    folder = mkdtempSync(join(tmpdir(), "libredb-e2e-"));
    [pg, mongo] = await Promise.all([
      startEngine("postgres", runId, extensionPath),
      startEngine("mongodb", runId, extensionPath),
    ]);
    await waitForPostgres(pg);
    await psql(pg, `create role pr11_user login password '${TEST_PASSWORD}'`);
    const env = { pg: pg.environment, mongo: mongo.environment };
    secrets.set(names[pgId], TEST_PASSWORD);
    secrets.set(names[pgServerId], TEST_PASSWORD);
    secrets.set(names[mongoId], env.mongo.MONGO_INITDB_ROOT_PASSWORD);
    const shape = (id: string, running: RunningEngine) => ({
      id,
      name: names[id],
      host: "127.0.0.1",
      port: running.port,
      createdAt: new Date().toISOString(),
      secretFields: ["password"],
    });
    await settings().update(
      "connections",
      [
        { ...shape(pgId, pg), type: "postgres", user: "pr11_user", database: env.pg.POSTGRES_DB },
        { ...shape(pgServerId, pg), type: "postgres", user: "pr11_user" },
        {
          ...shape(mongoId, mongo),
          type: "mongodb",
          user: env.mongo.MONGO_INITDB_ROOT_USERNAME,
          authSource: "admin",
          database: "libredb_e2e",
        },
      ],
      vscode.ConfigurationTarget.Global,
    );
  });

  beforeEach(() => {
    pickAnswers = [];
    picks = [];
    warnings = [];
    warningAnswer = undefined;
    errors = [];
    window.showQuickPick = (async (
      items: readonly vscode.QuickPickItem[] | Thenable<readonly vscode.QuickPickItem[]>,
    ) => {
      const shown = [...(await items)];
      picks.push(shown);
      if (pickAnswers.length === 0) return undefined;
      const label = pickAnswers.shift();
      return shown.find((item) => item.label === label);
    }) as unknown as typeof vscode.window.showQuickPick;
    window.showInputBox = ((options?: vscode.InputBoxOptions) => {
      const name = options?.title?.split(":")[0] ?? "";
      return Promise.resolve(secrets.get(name));
    }) as typeof vscode.window.showInputBox;
    window.showWarningMessage = ((message: string) => {
      warnings.push(message);
      return Promise.resolve(warningAnswer);
    }) as typeof vscode.window.showWarningMessage;
    window.showErrorMessage = ((message: string) => {
      errors.push(message);
      return Promise.resolve(undefined);
    }) as typeof vscode.window.showErrorMessage;
  });

  afterEach(async () => {
    Object.assign(window, originals);
    let closed = 0;
    for (; vscode.window.activeTextEditor !== undefined && closed < 50; closed += 1) await closeActive();
    // An untitled document opened within the close grace under a closed one's name takes over its binding, as a
    // language switch does (decision 5), so the next case starts once every grace has expired.
    if (closed > 0) await delay(1200);
  });

  after(async function () {
    this.timeout(120_000);
    try {
      await settings().update("connections", saved, vscode.ConfigurationTarget.Global);
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await Promise.all([pg, mongo].flatMap((running) => (running === undefined ? [] : [stopEngine(running)])));
      pg = undefined;
      mongo = undefined;
    }
  });

  it("publishes a run in the running and cancellable keys and spins the status item until it settles (criterion 14)", async function () {
    this.timeout(120_000);
    const editor = await newQuery(pgId);
    const uri = editor.document.uri.toString();
    await setText(editor, "select pg_sleep(3)");
    const run = vscode.commands.executeCommand("libredb.runQuery");
    await waitFor(
      () =>
        keyHolds(CONTEXT_KEYS.runningQueries, uri) &&
        keyHolds(CONTEXT_KEYS.cancellableQueries, uri) &&
        capture.statusItem().item.text.startsWith("$(loading~spin)"),
      1000,
      () => `the keys hold ${keys(uri)} and the item reads ${capture.statusItem().item.text}`,
    );
    await run;
    await waitFor(
      () => !keyHolds(CONTEXT_KEYS.runningQueries, uri),
      1000,
      () => "libredb.runningQueries still holds the document",
    );
    assert.equal(capture.statusItem().item.text, `$(database) ${names[pgId]}`);
    assert.deepEqual(errors, []);
  });

  it("keeps a MongoDB run out of the cancellable key once its statement is sent (criterion 14)", async function () {
    this.timeout(120_000);
    const editor = await newQuery(mongoId);
    const uri = editor.document.uri.toString();
    await setText(editor, JSON.stringify({ collection: "it_e2e", operation: "insertMany", documents: [{ n: 1 }] }));
    await runActive();
    const slow = { collection: "it_e2e", operation: "find", filter: { $where: "sleep(3000) || true" } };
    await setText(editor, JSON.stringify(slow));
    const started = Date.now();
    const from = capture.logLines.length;
    const run = vscode.commands.executeCommand("libredb.runQuery");
    let settled = false;
    void Promise.resolve(run).then(() => {
      settled = true;
    });
    await waitFor(
      () => settled || startedSince(from),
      5000,
      () => "the MongoDB run did not start",
    );
    let sampled = 0;
    // A function, so the loop reads the flag the run's own callback sets.
    const isSettled = () => settled;
    while (!isSettled()) {
      if (keyHolds(CONTEXT_KEYS.runningQueries, uri)) {
        sampled += 1;
        assert.equal(keyHolds(CONTEXT_KEYS.cancellableQueries, uri), false, "a sent MongoDB run is cancellable");
      }
      await delay(25);
    }
    const lines = capture.logLines.slice(-2);
    console.log(
      `mongodb: the $where run took ${Date.now() - started} ms, sampled ${sampled} times: ${lines.join(" | ")}`,
    );
    assert.ok(sampled > 0, "the run was never seen in libredb.runningQueries");
  });

  it("ends a running statement within 5 s of Cancel, logged as cancelled (criterion 15)", async function () {
    this.timeout(120_000);
    const from = capture.logLines.length;
    const { uri, run } = await sleeping();
    await vscode.commands.executeCommand("libredb.cancelQuery", vscode.Uri.parse(uri));
    const elapsed = await settlesWithin(run, 5000, "the cancelled run");
    console.log(`postgres: the run settled ${elapsed} ms after Cancel`);
    assert.ok(cancelledLine(capture.logLines.slice(from)), capture.logLines.slice(from).join("\n"));
  });

  it("keeps a bound untitled document's binding through its save and a rename of the file and of its folder (criterion 16)", async function () {
    this.timeout(120_000);
    const target = vscode.Uri.file(join(folder, "first", "q.sql"));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(`untitled:${target.fsPath}`));
    await vscode.window.showTextDocument(document);
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor);
    await setText(editor, "select 1 as a");
    pickAnswers = [names[pgId]];
    await vscode.commands.executeCommand("libredb.changeConnection");
    const untitled = document.uri.toString();
    await waitFor(
      () => keyHolds(CONTEXT_KEYS.boundDocuments, untitled),
      1000,
      () => "the untitled document is not bound",
    );

    const events: string[] = [];
    const listeners = [
      vscode.workspace.onWillSaveTextDocument((event) => events.push(`willSave ${event.document.uri.toString()}`)),
      vscode.workspace.onDidCloseTextDocument((closed) => events.push(`close ${closed.uri.toString()}`)),
      vscode.workspace.onDidOpenTextDocument((opened) => events.push(`open ${opened.uri.toString()}`)),
    ];
    try {
      assert.ok(await document.save(), "the untitled document was not saved");
    } finally {
      for (const listener of listeners) listener.dispose();
    }
    console.log(`the save fired: ${JSON.stringify(events)}`);
    const file = target.toString();
    await waitFor(
      () => keyHolds(CONTEXT_KEYS.boundDocuments, file) && !keyHolds(CONTEXT_KEYS.boundDocuments, untitled),
      2000,
      () => `the binding did not move to ${file}: ${JSON.stringify(contextValue(CONTEXT_KEYS.boundDocuments))}`,
    );
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
    await waitFor(
      () => capture.statusItem().shown && capture.statusItem().item.text === `$(database) ${names[pgId]}`,
      1000,
      () => `the item reads ${capture.statusItem().item.text}`,
    );

    const renamed = vscode.Uri.file(join(folder, "first", "r.sql"));
    let edit = new vscode.WorkspaceEdit();
    edit.renameFile(target, renamed);
    assert.ok(await vscode.workspace.applyEdit(edit));
    await waitFor(
      () => keyHolds(CONTEXT_KEYS.boundDocuments, renamed.toString()),
      2000,
      () => "the file rename lost the binding",
    );
    const moved = vscode.Uri.file(join(folder, "second"));
    edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(join(folder, "first")), moved);
    assert.ok(await vscode.workspace.applyEdit(edit));
    const inMoved = vscode.Uri.file(join(folder, "second", "r.sql")).toString();
    await waitFor(
      () => keyHolds(CONTEXT_KEYS.boundDocuments, inMoved),
      2000,
      () => `the folder rename lost the binding: ${JSON.stringify(contextValue(CONTEXT_KEYS.boundDocuments))}`,
    );
    const lines = await runActive();
    assert.ok(
      lines.some((line) => / answered 1 row /.test(line)),
      lines.join("\n"),
    );
  });

  it("drops a closed untitled editor's binding after its grace, and keeps it through a language switch (criterion 17)", async function () {
    this.timeout(120_000);
    const kept = await newQuery(pgId);
    const keptUri = kept.document.uri.toString();
    await vscode.languages.setTextDocumentLanguage(kept.document, "plaintext");
    await delay(1500);
    assert.ok(keyHolds(CONTEXT_KEYS.boundDocuments, keptUri), "the language switch unbound the document");

    const closing = await newQuery(pgId);
    const uri = closing.document.uri.toString();
    await closeActive();
    await delay(1200);
    assert.ok(!keyHolds(CONTEXT_KEYS.boundDocuments, uri), `${uri} is still bound`);
    const reopened = await vscode.workspace.openTextDocument({ language: "sql" });
    await vscode.window.showTextDocument(reopened);
    console.log(`the closed ${uri}, the next untitled ${reopened.uri.toString()}`);
    assert.ok(!keyHolds(CONTEXT_KEYS.boundDocuments, reopened.uri.toString()));
  });

  it("ends a run within 5 s when its editor closes, logged as cancelled (criterion 18)", async function () {
    this.timeout(120_000);
    const from = capture.logLines.length;
    const { run } = await sleeping();
    await closeActive();
    const elapsed = await settlesWithin(run, 5000, "the closed editor's run");
    console.log(`postgres: the run settled ${elapsed} ms after the close`);
    assert.ok(cancelledLine(capture.logLines.slice(from)), capture.logLines.slice(from).join("\n"));
  });

  it("shows the status item for a bound active editor, with its catalog, and Change Connection rebinds it (criterion 19)", async function () {
    this.timeout(120_000);
    const database = engine(pg).environment.POSTGRES_DB;
    const unbound = await vscode.workspace.openTextDocument({ language: "sql" });
    await vscode.window.showTextDocument(unbound);
    await waitFor(
      () => !capture.statusItem().shown,
      1000,
      () => "the item shows for an unbound editor",
    );

    const editor = await newQuery(pgServerId, database);
    const uri = editor.document.uri.toString();
    const { item } = capture.statusItem();
    await waitFor(
      () => capture.statusItem().shown,
      1000,
      () => "the item is hidden for a bound editor",
    );
    assert.equal(item.text, `$(database) ${names[pgServerId]} (${database})`);
    assert.equal(typeof item.command === "string" ? item.command : item.command?.command, "libredb.changeConnection");
    await vscode.window.showTextDocument(unbound);
    await waitFor(
      () => !capture.statusItem().shown,
      1000,
      () => "the item stayed for the unbound editor",
    );
    await vscode.window.showTextDocument(editor.document);
    await waitFor(
      () => capture.statusItem().shown,
      1000,
      () => "the item did not come back",
    );

    pickAnswers = [names[mongoId]];
    await vscode.commands.executeCommand("libredb.changeConnection");
    const rebound = vscode.window.activeTextEditor?.document;
    assert.equal(rebound?.uri.toString(), uri);
    assert.equal(rebound?.languageId, "json");
    await waitFor(
      () => item.text === `$(database) ${names[mongoId]}`,
      1000,
      () => `the item reads ${item.text}`,
    );

    const { run } = await sleeping();
    pickAnswers = [names[mongoId]];
    await vscode.commands.executeCommand("libredb.changeConnection");
    assert.deepEqual(warnings, [CHANGE_REFUSED]);
    assert.deepEqual(pickAnswers, [names[mongoId]], "Change Connection showed a pick during the run");
    await vscode.commands.executeCommand("libredb.cancelQuery");
    await settlesWithin(run, 5000, "the cancelled run");
  });

  it("cancels a run when its profile's host is edited, and the next run opens on the new host (part 2 criterion 19)", async function () {
    this.timeout(120_000);
    const from = capture.logLines.length;
    const { run } = await sleeping();
    const withHost = (host: string) =>
      savedConnections().map((entry) => (entry.id === pgId ? { ...entry, host } : entry));
    await settings().update("connections", withHost("127.0.0.2"), vscode.ConfigurationTarget.Global);
    const elapsed = await settlesWithin(run, 5000, "the run on the edited profile");
    console.log(`postgres: the run settled ${elapsed} ms after the host edit`);
    assert.ok(cancelledLine(capture.logLines.slice(from)), capture.logLines.slice(from).join("\n"));

    await setText(vscode.window.activeTextEditor as vscode.TextEditor, "select 1 as a");
    await runActive();
    console.log(`127.0.0.2 answered: ${JSON.stringify(errors)}`);
    assert.ok(
      errors.some((message) => message.includes("127.0.0.2")),
      JSON.stringify(errors),
    );

    await settings().update("connections", withHost("127.0.0.1"), vscode.ConfigurationTarget.Global);
    const lines = await runActive();
    assert.ok(
      lines.some((line) => / answered 1 row /.test(line)),
      lines.join("\n"),
    );
  });

  it("puts an unbound sql document in no LibreDB key, and Run on it asks for a connection and runs nothing (criterion 21)", async function () {
    this.timeout(120_000);
    const document = await vscode.workspace.openTextDocument({ language: "sql", content: "select 1" });
    await vscode.window.showTextDocument(document);
    const uri = document.uri.toString();
    await delay(200);
    console.log(`the unbound ${uri} is in ${keys(uri)}`);
    assert.equal(keys(uri), "[]");
    assert.equal(capture.statusItem().shown, false);
    const lines = await runActive();
    assert.equal(picks.length, 1, "Run showed no connection pick");
    assert.deepEqual(
      picks[0].map((item) => item.label),
      Object.values(names),
    );
    assert.deepEqual(lines, []);
    assert.equal(keys(uri), "[]");
  });

  it("ends a run within 5 s and unbinds its document when its connection is removed (criterion 20)", async function () {
    this.timeout(120_000);
    const from = capture.logLines.length;
    const { uri, run } = await sleeping();
    const node = ((await connectionsTree().provider.getChildren()) ?? []).find(
      (each) => (each as { id: string }).id === `c/${encodeURIComponent(pgId)}`,
    );
    assert.ok(node, "the root does not list the connection");
    warningAnswer = "Remove";
    await vscode.commands.executeCommand("libredb.removeConnection", node);
    const elapsed = await settlesWithin(run, 5000, "the removed connection's run");
    console.log(`postgres: the run settled ${elapsed} ms after the removal`);
    assert.ok(cancelledLine(capture.logLines.slice(from)), capture.logLines.slice(from).join("\n"));
    await waitFor(
      () => !keyHolds(CONTEXT_KEYS.boundDocuments, uri),
      1000,
      () => "the removed connection's document is still bound",
    );
  });
});
