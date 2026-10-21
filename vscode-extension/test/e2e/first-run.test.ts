// The first-run flow end to end in a real extension host (main design section 3, steps 2 to 6, and section 8 item 2),
// on PostgreSQL, SQL Server, MySQL and MongoDB: the empty view, Add Connection through the real quick inputs, New
// Query and Run, the tree down to a table and its columns, Select Rows to the Results view, Load More and Cancel.
// Criteria that already pass in editors.test.ts and results-view.test.ts are not repeated here. It needs Docker, so it
// stays out of the smoke subset.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { CONNECTION_FORM } from "@/lib/db/connection-form";
import { MORE_OPTIONS_TOOLTIP } from "../../src/host/connections/add-connection-flow";
import { COMMANDS, CONNECTIONS_VIEW, CONTEXT_KEYS, RESULTS_VIEW } from "../../src/host/names";
import { LOAD_MORE_REFUSED } from "../../src/host/results/results-presenter";
import { parseHostMessage } from "../../src/results-protocol";
import { ScriptedInputBox, ScriptedQuickInputs, type ScriptedQuickPick } from "../fakes/quick-input";
import {
  type EngineService,
  type RunningEngine,
  START_DEADLINE_MS,
  startEngine,
  stopEngine,
} from "../integration/containers";
import { ENGINES } from "../integration/engines";
import { contextValue, hostCapture, installHostCapture } from "./host-capture";
import { connectionsTree, installTreeCapture } from "./tree-capture";

const EXTENSION_ID = "libredb.libredb-studio";
const execFileAsync = promisify(execFile);

installHostCapture();
installTreeCapture();

/** Part 3 "Cancel": the engines whose provider implements cancelQuery. */
const CANCELS: Readonly<Record<EngineService, boolean>> = { postgres: true, mssql: true, mysql: true, mongodb: false };

/** One quick-input answer of the add walk: choose an item, accept a box, or press a button by its tooltip. */
type WalkStep = { choose: string } | { accept: string } | { press: string };

/** A tree node as the provider hands it out: only its id is read here. */
interface Node {
  readonly id: string;
}

interface Message {
  readonly type: string;
  readonly runId?: string;
  readonly statement?: string;
  readonly page?: { rows: Record<string, unknown>[]; pagination: { limit: number; hasMore: boolean } };
  readonly grid?: { supportsResultPagination: boolean };
  readonly failure?: { kind: string };
  readonly [key: string]: unknown;
}

const settings = () => vscode.workspace.getConfiguration("libredb");
const userConnections = (): readonly Record<string, unknown>[] =>
  settings().inspect<Record<string, unknown>[]>("connections")?.globalValue ?? [];

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

const tree = () => connectionsTree();
const childrenOf = async (node?: Node): Promise<Node[]> => ((await tree().provider.getChildren(node)) ?? []) as Node[];
const itemOf = async (node: Node): Promise<vscode.TreeItem> => await tree().provider.getTreeItem(node);
const labelOf = (item: vscode.TreeItem): string =>
  typeof item.label === "object" ? item.label.label : String(item.label ?? "");

/** One docker exec probe per engine that answers only once the engine's final server accepts a login. */
function readinessProbe(engine: RunningEngine): string[] {
  const id = engine.containerId;
  const env = engine.environment;
  switch (engine.service) {
    // pg_isready over TCP: the image's first, socket-only server does not answer it.
    case "postgres":
      return ["exec", id, "pg_isready", "-h", "127.0.0.1", "-q"];
    // MySQL's initialising server runs with networking off, so a TCP ping reaches the final one only.
    case "mysql":
      return [
        "exec",
        "-e",
        `MYSQL_PWD=${env.MYSQL_ROOT_PASSWORD}`,
        id,
        "mysqladmin",
        "ping",
        "-h",
        "127.0.0.1",
        "-uroot",
      ];
    // MongoDB's initialising server listens on loopback only, so the probe dials the container's own address.
    case "mongodb":
      return [
        "exec",
        id,
        "sh",
        "-c",
        'mongosh --quiet --host "$(hostname -i | cut -d" " -f1)" --eval "db.runCommand({ ping: 1 })"',
      ];
    case "mssql":
      return [
        "exec",
        "-e",
        `SQLCMDPASSWORD=${env.MSSQL_SA_PASSWORD}`,
        id,
        "/opt/mssql-tools18/bin/sqlcmd",
        "-S",
        "127.0.0.1",
        "-U",
        "sa",
        "-C",
        "-Q",
        "select 1",
      ];
  }
}

/** Runs the engine's readiness probe every 500 ms until it succeeds; answers the time it took. */
async function waitForLogin(engine: RunningEngine): Promise<number> {
  const started = Date.now();
  for (;;) {
    try {
      await execFileAsync("docker", readinessProbe(engine));
      return Date.now() - started;
    } catch (error) {
      if (Date.now() - started > START_DEADLINE_MS) throw error;
    }
    await delay(500);
  }
}

/** The add walk of each engine, built at run time from its container's environment and port. */
function walkOf(engine: RunningEngine): WalkStep[] {
  const env = engine.environment;
  const label = CONNECTION_FORM[engine.service].label;
  const details = (user: string, password: string, database: string): WalkStep[] => [
    { choose: label },
    { choose: "Enter connection details" },
    { accept: "127.0.0.1" },
    { accept: String(engine.port) },
    { accept: user },
    { accept: password },
    { accept: database },
  ];
  switch (engine.service) {
    case "postgres":
      return details(env.POSTGRES_USER, env.POSTGRES_PASSWORD, env.POSTGRES_DB);
    case "mysql":
      return details("root", env.MYSQL_ROOT_PASSWORD, env.MYSQL_DATABASE);
    // docs/providers/mssql.md section 4.3: require encrypts and skips the validation a self-signed local server fails.
    // More Options on the Database box opens Review, which sets the database, then SSL mode.
    case "mssql":
      return [
        ...details("sa", env.MSSQL_SA_PASSWORD, "master").slice(0, -1),
        { press: MORE_OPTIONS_TOOLTIP },
        { choose: "Database" },
        { accept: "master" },
        { choose: "SSL mode" },
        { choose: "require" },
        { choose: "Test and Continue" },
      ];
    // Part 2 criterion 8: the pasted string is kept verbatim as the connection's one secret.
    case "mongodb": {
      const user = encodeURIComponent(env.MONGO_INITDB_ROOT_USERNAME);
      const password = encodeURIComponent(env.MONGO_INITDB_ROOT_PASSWORD);
      return [
        { choose: label },
        { choose: "Paste a connection string" },
        { accept: `mongodb://${user}:${password}@127.0.0.1:${engine.port}/libredb_it?authSource=admin` },
      ];
    }
  }
}

/** Resolves once the pick is no longer busy and holds its items. */
async function settled(pick: ScriptedQuickPick<vscode.QuickPickItem>): Promise<void> {
  await waitFor(
    () => !pick.busy && pick.items.length > 0,
    30_000,
    () => `the pick ${pick.title} stayed busy`,
  );
}

describe("the first-run flow in a real extension host", () => {
  const runId = `${process.pid}-${Date.now()}`;
  const engines = new Map<EngineService, RunningEngine>();
  const capture = hostCapture();
  const results = capture.results();
  let savedConnections: unknown;
  let savedRowLimit: unknown;
  /** Where the Results view's capture stood once the before passed. */
  let postedFrom = 0;
  let receivedFrom = 0;
  /** What the next showQuickPick answers: the first item whose label is listed, or undefined to dismiss. */
  let pickLabels: string[] = [];
  const picks: string[][] = [];
  const warnings: string[] = [];
  /** What showInputBox was asked: every secret is in secret storage after the walk, so nothing should be. */
  const asked: string[] = [];
  type Patched = "createQuickPick" | "createInputBox" | "showQuickPick" | "showInputBox" | "showWarningMessage";
  const window = vscode.window as unknown as Record<Patched, unknown>;
  const originals: Partial<Record<Patched, unknown>> = {};

  function patch(doubles: Partial<Record<Patched, unknown>>): void {
    for (const [name, double] of Object.entries(doubles) as [Patched, unknown][]) {
      originals[name] ??= window[name];
      window[name] = double;
      assert.equal(window[name], double, `vscode.window.${name} did not take the double`);
    }
  }

  const engineOf = (service: EngineService): RunningEngine => {
    const running = engines.get(service);
    assert.ok(running, `${service} is not running`);
    return running;
  };

  async function setText(editor: vscode.TextEditor, text: string): Promise<void> {
    const whole = new vscode.Range(0, 0, editor.document.lineCount, 0);
    assert.ok(await editor.edit((builder) => builder.replace(whole, text)));
  }

  /** Waits until the posted messages from `from` on hold `count`, and answers them. */
  async function postedSince(from: number, count: number, what: string, ms = 10_000): Promise<Message[]> {
    await waitFor(
      () => results.posted.length >= from + count,
      ms,
      () => `${what}: posted ${JSON.stringify(typesOf(results.posted.slice(from)))}`,
    );
    return results.posted.slice(from) as Message[];
  }

  /** Waits for the thenable, failing after ms; answers the time it took. */
  async function settlesWithin(thenable: Thenable<unknown>, ms: number, what: string): Promise<number> {
    const started = Date.now();
    const done = await Promise.race([Promise.resolve(thenable).then(() => true), delay(ms).then(() => false)]);
    const elapsed = Date.now() - started;
    assert.ok(done, `${what} had not settled after ${ms} ms`);
    return elapsed;
  }

  /** Reverts and closes every editor. */
  async function closeEditors(): Promise<void> {
    let closed = 0;
    for (; vscode.window.activeTextEditor !== undefined && closed < 50; closed += 1) {
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    }
    // An untitled document opened within the close grace under a closed one's name takes over its binding.
    if (closed > 0) await delay(1200);
  }

  before(async function () {
    this.timeout(START_DEADLINE_MS * 2 + 120_000);
    savedConnections = settings().inspect("connections")?.globalValue;
    savedRowLimit = settings().inspect("query.rowLimit")?.globalValue;
    await settings().update("connections", [], vscode.ConfigurationTarget.Global);
    await settings().update("query.rowLimit", 2, vscode.ConfigurationTarget.Global);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not loaded in the test instance`);
    await extension.activate();
    const outcomes = await Promise.allSettled(
      ENGINES.map((fixture) => startEngine(fixture.service, runId, extension.extensionPath)),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") engines.set(outcome.value.service, outcome.value);
    }
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    if (failed !== undefined) throw failed.reason;
    await Promise.all(
      [...engines.values()].map(async (engine) => {
        const ms = await waitForLogin(engine);
        console.log(`${engine.service}: the readiness probe answered after ${ms} ms`);
      }),
    );
    // The view is shown and its webview ready before any run, so every message the host posts reaches a live view.
    const received = results.received.length;
    await vscode.commands.executeCommand("workbench.action.closePanel");
    await vscode.commands.executeCommand(`${RESULTS_VIEW}.focus`);
    await waitFor(
      () => results.received.slice(received).some((raw) => (raw as Message).type === "ready"),
      20_000,
      () => `no ready from the view: received ${JSON.stringify(results.received.slice(received))}`,
    );
    postedFrom = results.posted.length;
    receivedFrom = results.received.length;
  });

  beforeEach(() => {
    pickLabels = [];
    patch({
      showQuickPick: (async (items: readonly vscode.QuickPickItem[] | Thenable<readonly vscode.QuickPickItem[]>) => {
        const shown = [...(await items)];
        picks.push(shown.map((item) => item.label));
        return shown.find((item) => pickLabels.includes(item.label));
      }) as unknown,
      showInputBox: ((options?: vscode.InputBoxOptions) => {
        asked.push(String(options?.title ?? options?.prompt));
        return Promise.resolve(undefined);
      }) as unknown,
      showWarningMessage: ((message: string) => {
        warnings.push(message);
        return Promise.resolve(undefined);
      }) as unknown,
    });
  });

  afterEach(() => {
    for (const [name, original] of Object.entries(originals)) window[name as Patched] = original;
    for (const name of Object.keys(originals)) delete originals[name as Patched];
  });

  after(async function () {
    this.timeout(120_000);
    try {
      await closeEditors();
      await settings().update("connections", savedConnections, vscode.ConfigurationTarget.Global);
      await settings().update("query.rowLimit", savedRowLimit, vscode.ConfigurationTarget.Global);
    } finally {
      await Promise.all([...engines.values()].map((engine) => stopEngine(engine)));
      engines.clear();
    }
  });

  it("opens the LibreDB view on an empty tree, which VS Code shows as the Add Connection welcome (step 2)", async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand("workbench.view.extension.libredb");
    const started = Date.now();
    while ((await childrenOf()).length > 0) {
      if (Date.now() - started > 5000) assert.fail("the root still lists connections");
      await delay(50);
    }
    const manifest = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as {
      contributes: { viewsWelcome: unknown[] };
    };
    assert.deepEqual(manifest.contributes.viewsWelcome, [
      { view: CONNECTIONS_VIEW, contents: "No connections yet.\n[Add Connection](command:libredb.addConnection)" },
    ]);
  });

  for (const fixture of ENGINES) {
    describe(`on ${CONNECTION_FORM[fixture.service].label}`, () => {
      let connectionId: string | undefined;
      let connectionName: string | undefined;
      let queryEditor: vscode.TextEditor | undefined;
      let relation: Node | undefined;

      const connectionNode = async (): Promise<Node> => {
        assert.ok(connectionId, "the add case saved no connection");
        const found = (await childrenOf()).find(
          (node) => node.id === `c/${encodeURIComponent(connectionId as string)}`,
        );
        assert.ok(found, `the root does not list ${connectionId}`);
        return found;
      };

      after(async function () {
        this.timeout(60_000);
        await closeEditors();
      });

      it("adds the connection through the real quick inputs, keeping its secret out of the setting (step 3)", async function () {
        this.timeout(120_000);
        const engine = engineOf(fixture.service);
        const screen = new ScriptedQuickInputs(vscode.QuickInputButtons.Back);
        patch({ createQuickPick: () => screen.createQuickPick(), createInputBox: () => screen.createInputBox() });
        const nextInput = async () => {
          const input = await Promise.race([screen.next(), delay(60_000).then(() => undefined)]);
          if (input === undefined) {
            const titles = screen.shown.map((shown) => shown.title).join(" | ");
            assert.fail(`no quick input within 60 s after ${titles}; warnings ${JSON.stringify(warnings)}`);
          }
          return input;
        };
        const before = userConnections();
        const started = Date.now();
        const adding = vscode.commands.executeCommand<string | undefined>(COMMANDS.addConnection);
        for (const step of walkOf(engine)) {
          const input = await nextInput();
          if ("choose" in step) {
            await settled(input as ScriptedQuickPick<vscode.QuickPickItem>);
            screen.choose(step.choose);
          } else if ("accept" in step) {
            screen.accept(step.accept);
          } else {
            const button = input.buttons.find((each) => each.tooltip === step.press);
            assert.ok(button, `${input.title} has no button "${step.press}"`);
            screen.press(button);
          }
        }
        // The test shows as a busy pick; the name box follows it.
        for (;;) {
          const input = await nextInput();
          if (input instanceof ScriptedInputBox) {
            connectionName = input.value;
            screen.accept(input.value);
            break;
          }
        }
        connectionId = await adding;
        console.log(
          `${fixture.service}: the add walk took ${Date.now() - started} ms through ${screen.shown.map((input) => input.title).join(" | ")}`,
        );
        assert.match(connectionId ?? "", /^[0-9a-z]+$/);
        const saved = userConnections();
        assert.deepEqual(saved.slice(0, before.length), before);
        assert.equal(saved.length, before.length + 1, JSON.stringify(saved));
        const entry = saved[before.length];
        assert.equal(entry.id, connectionId);
        assert.equal(entry.type, fixture.service);
        assert.equal(entry.name, connectionName);
        assert.ok(!("password" in entry) && !("connectionString" in entry), JSON.stringify(entry));
        const node = await connectionNode();
        await waitFor(
          () => tree().view.selection.some((selected) => (selected as Node).id === node.id),
          5000,
          () => `the view selects ${JSON.stringify(tree().view.selection.map((selected) => (selected as Node).id))}`,
        );
      });

      it("opens a bound New Query editor and runs the fixture's statements in it (step 5)", async function () {
        this.timeout(120_000);
        pickLabels = [fixture.tableContainer[0]];
        await vscode.commands.executeCommand(COMMANDS.newQuery, await connectionNode());
        const editor = vscode.window.activeTextEditor;
        assert.ok(editor, `New Query showed no editor; picks ${JSON.stringify(picks)}`);
        queryEditor = editor;
        const uri = editor.document.uri.toString();
        assert.ok(keyHolds(CONTEXT_KEYS.boundDocuments, uri), `${uri} is not bound`);
        await waitFor(
          () => capture.statusItem().shown,
          1000,
          () => "the status item is hidden for the bound editor",
        );
        for (const statement of fixture.setup) {
          await setText(editor, statement);
          const from = results.posted.length;
          await vscode.commands.executeCommand(COMMANDS.runQuery);
          const posted = await postedSince(from, 2, statement);
          assert.deepEqual(typesOf(posted), ["runStarted", "runSucceeded"], JSON.stringify(posted));
        }
      });

      it("lists the table and its columns in the tree (step 4)", async function () {
        this.timeout(120_000);
        const root = await connectionNode();
        await vscode.commands.executeCommand(COMMANDS.refresh, root);
        const found: { node: Node; path: string[] }[] = [];
        const errors: string[] = [];
        let level: { node: Node; path: string[] }[] = [{ node: root, path: [] }];
        for (let depth = 1; depth <= 6 && level.length > 0; depth += 1) {
          const next: { node: Node; path: string[] }[] = [];
          for (const { node, path } of level) {
            for (const child of await childrenOf(node)) {
              const item = await itemOf(child);
              const label = labelOf(item);
              const context = item.contextValue ?? "";
              if (context === "libredb;node=error") errors.push(`${[...path, label].join(" / ")}: ${item.tooltip}`);
              if (/\brole=relation\b/.test(context) && label === fixture.tableName) found.push({ node: child, path });
              // Objects are leaves of the walk; a relation's columns are read below.
              if (
                !context.startsWith("libredb;node=object") &&
                item.collapsibleState !== vscode.TreeItemCollapsibleState.None
              ) {
                next.push({ node: child, path: [...path, label] });
              }
            }
          }
          level = next;
        }
        assert.deepEqual(errors, []);
        assert.equal(found.length, 1, JSON.stringify(found.map((each) => each.path)));
        const [{ node, path }] = found;
        const inOrder = fixture.tableContainer.reduce(
          (from, label) => (from < 0 ? from : path.indexOf(label, from) < 0 ? -1 : path.indexOf(label, from) + 1),
          0,
        );
        assert.ok(inOrder >= 0, `${fixture.tableName} sits under ${path.join(" / ")}`);
        relation = node;
        const columns = await Promise.all((await childrenOf(node)).map(async (child) => labelOf(await itemOf(child))));
        console.log(`${fixture.service}: ${[...path, fixture.tableName].join(" / ")} has ${JSON.stringify(columns)}`);
        if (fixture.service !== "mongodb") assert.ok(columns.includes("n"), JSON.stringify(columns));
      });

      it("runs Select Rows into the Results view, and pages it by Load More where the engine pages (steps 5 and 6)", async function () {
        this.timeout(120_000);
        assert.ok(relation, "the tree case found no table");
        const from = results.posted.length;
        await vscode.commands.executeCommand(COMMANDS.selectRows, relation);
        const editor = vscode.window.activeTextEditor;
        assert.ok(editor, "Select Rows showed no editor");
        assert.notEqual(editor.document.uri.toString(), queryEditor?.document.uri.toString());
        const posted = await postedSince(from, 2, "Select Rows");
        assert.deepEqual(typesOf(posted), ["runStarted", "runSucceeded"], JSON.stringify(posted));
        const [started, succeeded] = posted;
        assert.equal(started.statement, editor.document.getText());
        const label = editor.document.uri.path.split("/").at(-1);
        assert.equal(results.description, `${label} on ${connectionName}`);
        assert.ok(succeeded.page && succeeded.grid && succeeded.runId);
        console.log(
          `${fixture.service}: Select Rows ran ${JSON.stringify(started.statement)} and answered ${JSON.stringify(succeeded.page.rows)} with ${JSON.stringify(succeeded.page.pagination)}`,
        );
        const pagedFrom = results.posted.length;
        const logFrom = capture.logLines.length;
        results.send({ v: 1, type: "loadMore", runId: succeeded.runId });
        if (succeeded.grid.supportsResultPagination) {
          assert.equal(succeeded.page.rows.length, 2);
          assert.equal(succeeded.page.pagination.limit, 2);
          assert.equal(succeeded.page.pagination.hasMore, true);
          const more = await postedSince(pagedFrom, 2, "Load More");
          assert.deepEqual(typesOf(more), ["pageStarted", "pageAppended"], JSON.stringify(more));
          assert.equal(more[1].page?.rows.length, 2);
          assert.equal(more[1].page?.pagination.hasMore, false);
          const values = [...succeeded.page.rows, ...(more[1].page?.rows ?? [])].map((row) => Number(row.n));
          assert.deepEqual(new Set(values), new Set([1, 2, 3, 4]));
        } else {
          // Part 4 criterion 11: every row in one page and no Load More. The page says no more rows follow, which is
          // the first of criterion 7's refusals the record fails, ahead of the connection's lack of pagination.
          assert.equal(succeeded.page.rows.length, 4);
          assert.equal(succeeded.page.pagination.hasMore, false);
          await delay(1000);
          assert.deepEqual(results.posted.slice(pagedFrom), []);
          assert.ok(
            capture.logLines.slice(logFrom).includes(`Load More was refused: ${LOAD_MORE_REFUSED.noMore}.`),
            capture.logLines.slice(logFrom).join("\n"),
          );
        }
      });

      it(
        CANCELS[fixture.service]
          ? "ends a running statement within 5 s of Cancel"
          : "keeps a sent statement out of the cancellable key, and lets it finish",
        async function () {
          this.timeout(120_000);
          assert.ok(queryEditor, "the New Query case opened no editor");
          const editor = await vscode.window.showTextDocument(queryEditor.document);
          await setText(editor, fixture.slowStatement);
          const uri = editor.document.uri.toString();
          const from = results.posted.length;
          const logFrom = capture.logLines.length;
          let finished = false;
          const run = vscode.commands.executeCommand(COMMANDS.runQuery);
          void Promise.resolve(run).then(() => {
            finished = true;
          });
          await waitFor(
            () => keyHolds(CONTEXT_KEYS.runningQueries, uri),
            5000,
            () => `the run of ${uri} did not start`,
          );
          if (CANCELS[fixture.service]) {
            await waitFor(
              () => keyHolds(CONTEXT_KEYS.cancellableQueries, uri),
              5000,
              () => "the run never became cancellable",
            );
            await vscode.commands.executeCommand(COMMANDS.cancelQuery, vscode.Uri.parse(uri));
            const elapsed = await settlesWithin(run, 5000, "the cancelled run");
            console.log(`${fixture.service}: the run settled ${elapsed} ms after Cancel`);
            const posted = await postedSince(from, 2, "the cancelled run");
            assert.deepEqual(typesOf(posted), ["runStarted", "runFailed"], JSON.stringify(posted));
            assert.deepEqual(posted[1].failure, { kind: "cancelled" });
            const lines = capture.logLines.slice(logFrom);
            assert.ok(
              lines.some((line) => /^Run \S+ was cancelled\.$/.test(line)),
              lines.join("\n"),
            );
          } else {
            let sampled = 0;
            const isFinished = () => finished;
            const started = Date.now();
            while (!isFinished()) {
              if (keyHolds(CONTEXT_KEYS.runningQueries, uri)) {
                sampled += 1;
                assert.equal(keyHolds(CONTEXT_KEYS.cancellableQueries, uri), false, "a sent run is cancellable");
              }
              if (Date.now() - started > 90_000) assert.fail("the run had not finished after 90 s");
              await delay(25);
            }
            console.log(`${fixture.service}: the run took ${Date.now() - started} ms, sampled ${sampled} times`);
            assert.ok(sampled > 0, "the run was never seen in libredb.runningQueries");
            const posted = await postedSince(from, 2, "the slow run");
            assert.deepEqual(typesOf(posted), ["runStarted", "runSucceeded"], JSON.stringify(typesOf(posted)));
          }
        },
      );
    });
  }

  describe("the Results view's messages", () => {
    it("are each a valid host message, the view reported no error, and no input box asked for a secret", () => {
      const posted = results.posted.slice(postedFrom);
      assert.ok(posted.length > 0, "nothing was posted");
      for (const message of posted) parseHostMessage(message);
      const reports = results.received.slice(receivedFrom).filter((raw) => (raw as Message).type === "reportError");
      assert.deepEqual(reports, []);
      assert.deepEqual(asked, []);
    });
  });
});
