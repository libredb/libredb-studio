// LibreDB beside an installed SQL extension (part 3 criterion 21, "Coexisting with pgsql and mssql"): this host loads
// the extensions directory scripts/coexistence-extensions.mjs filled, so ms-mssql.mssql runs beside LibreDB. LibreDB
// shows its UI only on documents it bound; what mssql does on a LibreDB-bound document, its diagnostics and its Panel
// views are printed for the record, not asserted. It needs Docker and the Marketplace, so it runs in the coexistence
// subset only.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { COMMANDS, CONTEXT_KEYS, RESULTS_VIEW } from "../../src/host/names";
import { TEST_PASSWORD } from "../fakes/credentials";
import { PG } from "../fakes/profiles";
import { psql, type RunningEngine, START_DEADLINE_MS, startEngine, stopEngine } from "../integration/containers";
import { contextValue, hostCapture, installHostCapture } from "../e2e/host-capture";

const EXTENSION_ID = "libredb.libredb-studio";
const MSSQL_ID = "ms-mssql.mssql";
const MSSQL_VERSION = "1.46.0";
const execFileAsync = promisify(execFile);

installHostCapture();

interface Message {
  readonly type: string;
}

interface MssqlManifest {
  version: string;
  contributes?: {
    viewsContainers?: { panel?: { id: string }[] };
    views?: Record<string, { id: string }[]>;
    keybindings?: { command: string; key?: string; when?: string }[];
  };
}

const settings = () => vscode.workspace.getConfiguration("libredb");

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

const typesOf = (messages: readonly unknown[]): string[] => messages.map((message) => (message as Message).type);

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

describe("LibreDB beside ms-mssql.mssql in a real extension host", () => {
  const runId = `${process.pid}-${Date.now()}`;
  const connectionId = `pr14co-${runId}`;
  const connectionName = "e2e coexistence pg";
  let pg: RunningEngine | undefined;
  let saved: unknown;
  let mssql: vscode.Extension<unknown> | undefined;
  const capture = hostCapture();
  const results = capture.results();
  let picks: string[][] = [];
  let pickAnswer: string | undefined;
  const window = vscode.window as {
    -readonly [K in "showQuickPick" | "showInputBox"]: (typeof vscode.window)[K];
  };
  const originals = { showQuickPick: window.showQuickPick, showInputBox: window.showInputBox };

  const mssqlManifest = (): MssqlManifest => {
    assert.ok(mssql, `${MSSQL_ID} is not loaded`);
    return mssql.packageJSON as MssqlManifest;
  };

  async function setText(editor: vscode.TextEditor, text: string): Promise<void> {
    const whole = new vscode.Range(0, 0, editor.document.lineCount, 0);
    assert.ok(await editor.edit((builder) => builder.replace(whole, text)));
  }

  /** Waits until the posted messages from `from` on hold `count`, and answers their types. */
  async function postedSince(from: number, count: number, what: string): Promise<string[]> {
    await waitFor(
      () => results.posted.length >= from + count,
      10_000,
      () => `${what}: posted ${JSON.stringify(typesOf(results.posted.slice(from)))}`,
    );
    return typesOf(results.posted.slice(from));
  }

  /** A bound New Query editor on the connection, holding `select 1`. */
  async function boundEditor(): Promise<vscode.TextEditor> {
    pickAnswer = connectionName;
    await vscode.commands.executeCommand(COMMANDS.newQuery);
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, "New Query showed no editor");
    await setText(editor, "select 1");
    return editor;
  }

  before(async function () {
    this.timeout(START_DEADLINE_MS + 180_000);
    mssql = vscode.extensions.getExtension(MSSQL_ID);
    assert.ok(mssql, "mssql is not installed in this host's extensions directory");
    assert.equal(mssqlManifest().version, MSSQL_VERSION);
    const activation = await Promise.race([
      Promise.resolve(mssql.activate()).then(
        () => "resolved",
        (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
      ),
      delay(60_000).then(() => "timed out after 60 s"),
    ]);
    console.log(`VS Code ${vscode.version}: ${MSSQL_ID}@${MSSQL_VERSION} activation ${activation}`);
    saved = settings().inspect("connections")?.globalValue;
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not loaded in the test instance`);
    await extension.activate();
    pg = await startEngine("postgres", runId, extension.extensionPath);
    await waitForPostgres(pg);
    await psql(pg, `create role pr14_user login password '${TEST_PASSWORD}'`);
    await settings().update(
      "connections",
      [
        {
          id: connectionId,
          name: connectionName,
          type: "postgres",
          host: "127.0.0.1",
          port: pg.port,
          user: "pr14_user",
          database: pg.environment.POSTGRES_DB,
          createdAt: new Date().toISOString(),
          secretFields: PG.secretFields,
        },
      ],
      vscode.ConfigurationTarget.Global,
    );
    // The view is shown and its webview ready before any run, so every message the host posts reaches a live view.
    const received = results.received.length;
    await vscode.commands.executeCommand(`${RESULTS_VIEW}.focus`);
    await waitFor(
      () => results.received.slice(received).some((raw) => (raw as Message).type === "ready"),
      20_000,
      () => `no ready from the view: received ${JSON.stringify(results.received.slice(received))}`,
    );
  });

  beforeEach(() => {
    picks = [];
    pickAnswer = undefined;
    window.showQuickPick = (async (
      items: readonly vscode.QuickPickItem[] | Thenable<readonly vscode.QuickPickItem[]>,
    ) => {
      const shown = [...(await items)];
      picks.push(shown.map((item) => item.label));
      const answer = pickAnswer;
      pickAnswer = undefined;
      return shown.find((item) => item.label === answer);
    }) as unknown as typeof vscode.window.showQuickPick;
    window.showInputBox = (() => Promise.resolve(TEST_PASSWORD)) as typeof vscode.window.showInputBox;
  });

  afterEach(async () => {
    Object.assign(window, originals);
    let closed = 0;
    for (; vscode.window.activeTextEditor !== undefined && closed < 50; closed += 1) {
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    }
    if (closed > 0) await delay(1200);
  });

  after(async function () {
    this.timeout(120_000);
    try {
      await settings().update("connections", saved, vscode.ConfigurationTarget.Global);
    } finally {
      if (pg !== undefined) await stopEngine(pg);
      pg = undefined;
    }
  });

  it("puts an unbound sql document in no LibreDB key, shows no status item, and Run on it runs nothing (criterion 21)", async function () {
    this.timeout(120_000);
    const document = await vscode.workspace.openTextDocument({ language: "sql", content: "select 1" });
    await vscode.window.showTextDocument(document);
    const uri = document.uri.toString();
    await delay(500);
    for (const key of Object.values(CONTEXT_KEYS)) assert.equal(keyHolds(key, uri), false, `${key} holds ${uri}`);
    assert.equal(capture.statusItem().shown, false);
    const logFrom = capture.logLines.length;
    const postedFrom = results.posted.length;
    await vscode.commands.executeCommand(COMMANDS.runQuery);
    assert.deepEqual(picks, [[connectionName]], "Run showed no connection pick");
    assert.deepEqual(
      capture.logLines.slice(logFrom).filter((line) => /^Run \S+ started on /.test(line)),
      [],
    );
    assert.deepEqual(results.posted.slice(postedFrom), []);
  });

  it("runs a LibreDB-bound document beside mssql, and records mssql's diagnostics on it", async function () {
    this.timeout(120_000);
    const editor = await boundEditor();
    const uri = editor.document.uri;
    assert.ok(keyHolds(CONTEXT_KEYS.boundDocuments, uri.toString()), "the New Query editor is not bound");
    const from = results.posted.length;
    await vscode.commands.executeCommand(COMMANDS.runQuery);
    assert.deepEqual(await postedSince(from, 2, "the bound run"), ["runStarted", "runSucceeded"]);
    await delay(10_000);
    const diagnostics = vscode.languages.getDiagnostics(uri).map((each) => `${each.source}: ${each.message}`);
    console.log(
      `VS Code ${vscode.version}: ${editor.document.languageId} document ${uri.toString()} has ${JSON.stringify(diagnostics)}`,
    );
  });

  it("keeps the LibreDB Results view working beside mssql's Panel views", async function () {
    this.timeout(120_000);
    const { viewsContainers, views } = mssqlManifest().contributes ?? {};
    const panels = (viewsContainers?.panel ?? []).map((container) => container.id);
    const panelViews = panels.flatMap((container) => (views?.[container] ?? []).map((view) => view.id));
    console.log(
      `${MSSQL_ID} contributes the Panel containers ${JSON.stringify(panels)} with ${JSON.stringify(panelViews)}`,
    );
    let focused = 0;
    for (const view of panelViews) {
      const outcome = await Promise.resolve(vscode.commands.executeCommand(`${view}.focus`)).then(
        () => "focused",
        (error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (outcome === "focused") focused += 1;
      console.log(`${view}.focus: ${outcome}`);
    }
    assert.ok(focused > 0, `no ${MSSQL_ID} Panel view took focus, so the Results view was never displaced`);
    // A focused view of another Panel container hides LibreDB's, so only the focus below can show it again.
    await waitFor(
      () => !results.visible,
      10_000,
      () => `the Results view stayed visible beside ${MSSQL_ID}'s focused Panel view`,
    );
    const received = results.received.length;
    await vscode.commands.executeCommand(`${RESULTS_VIEW}.focus`);
    await waitFor(
      () => results.visible,
      10_000,
      () => `${RESULTS_VIEW}.focus left the Results view hidden`,
    );
    const ready = results.received.slice(received).some((raw) => (raw as Message).type === "ready");
    console.log(`${RESULTS_VIEW}.focus: visible ${results.visible}, ready ${ready}, resolves ${results.resolves}`);
    await boundEditor();
    const from = results.posted.length;
    await vscode.commands.executeCommand(COMMANDS.runQuery);
    assert.deepEqual(await postedSince(from, 2, "the second run"), ["runStarted", "runSucceeded"]);
  });

  it("contributes no keybinding, and no mssql keybinding names a LibreDB context key", () => {
    const manifest = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as {
      contributes: { keybindings?: unknown };
    };
    assert.equal(manifest.contributes.keybindings, undefined);
    const keybindings = mssqlManifest().contributes?.keybindings ?? [];
    for (const binding of keybindings)
      console.log(`${MSSQL_ID}: ${binding.key} ${binding.command} when ${binding.when}`);
    const libredb = keybindings.filter((binding) => /\blibredb\./.test(binding.when ?? ""));
    assert.deepEqual(libredb, []);
  });
});
