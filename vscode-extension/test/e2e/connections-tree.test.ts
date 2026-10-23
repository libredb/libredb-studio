// The Connections tree over PostgreSQL in a real extension host (part 2 criteria 14, 16, 19 and 21, their tree and
// open halves): Add Connection reveals what it saved, a first expand asks once for a secret this machine never stored,
// a host edit reaches the next expand, and no secret reaches the log or the child. It needs Docker, so it stays out of
// the smoke subset.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { psql, type RunningEngine, START_DEADLINE_MS, startEngine, stopEngine } from "../integration/containers";
import { type ScriptedQuickPick, ScriptedQuickInputs } from "../fakes/quick-input";
import { connectionsTree, installTreeCapture } from "./tree-capture";

const EXTENSION_ID = "libredb.libredb-studio";
const execFileAsync = promisify(execFile);

installTreeCapture();

/** A node as the tree hands it out: only its id is read here. */
interface Node {
  readonly id: string;
}

async function activated(): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not loaded in the test instance`);
  await extension.activate();
  return extension;
}

const tree = () => connectionsTree();
const childrenOf = async (node?: Node): Promise<Node[]> => ((await tree().provider.getChildren(node)) ?? []) as Node[];
const itemOf = async (node: Node): Promise<vscode.TreeItem> => await tree().provider.getTreeItem(node);
const labelsOf = async (nodes: readonly Node[]): Promise<string[]> =>
  await Promise.all(nodes.map(async (node) => String((await itemOf(node)).label)));

const settings = () => vscode.workspace.getConfiguration("libredb");
const savedConnections = (): readonly Record<string, unknown>[] =>
  settings().get<Record<string, unknown>[]>("connections") ?? [];

/** The connection node of the id at the root, once the root lists it. */
async function rootNode(id: string): Promise<Node> {
  const started = Date.now();
  for (;;) {
    const found = (await childrenOf()).find((node) => node.id === `c/${encodeURIComponent(id)}`);
    if (found !== undefined) return found;
    if (Date.now() - started > 5000) assert.fail(`the root does not list ${id}`);
    await delay(50);
  }
}

/** Resolves on the provider's next change event, and fails after 5 s. */
function nextChange(): Promise<void> {
  const event = tree().provider.onDidChangeTreeData;
  assert.ok(event, "the provider has no change event");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listener.dispose();
      reject(new Error("the provider fired no change within 5 s"));
    }, 5000);
    const listener = event(() => {
      clearTimeout(timer);
      listener.dispose();
      resolve();
    });
  });
}

/** The command lines, with pids, of this extension host's children that run dist/backend.js. */
async function backendChildren(): Promise<{ pid: number; args: string }[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pid=,args=", "--ppid", String(process.pid)]);
    return stdout
      .split("\n")
      .filter((line) => line.includes("dist/backend.js"))
      .map((line) => {
        const [, pid, args] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [];
        return { pid: Number(pid), args };
      });
  } catch (error) {
    // ps exits 1, printing nothing, when the process has no children at all.
    if ((error as { code?: unknown; stdout?: unknown }).code === 1 && (error as { stdout?: unknown }).stdout === "") {
      return [];
    }
    throw error;
  }
}

/** Every file under dir named name. */
function filesNamed(dir: string, name: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesNamed(path, name);
    return entry.name === name ? [path] : [];
  });
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

describe("the Connections tree over PostgreSQL in a real extension host", () => {
  const runId = `${process.pid}-${Date.now()}`;
  const sentinel = `pr9-sentinel-${runId}`;
  const promptedId = `pr9p-${runId}`;
  const declinedId = `pr9d-${runId}`;
  let engine: RunningEngine | undefined;
  let saved: unknown;
  let inputs: ScriptedQuickInputs;
  /** The secret boxes shown since the case began, by title, and what the next one answers. */
  let boxes: string[] = [];
  let boxAnswer: string | undefined;
  let errors: string[] = [];
  const window = vscode.window as {
    -readonly [K in
      | "createQuickPick"
      | "createInputBox"
      | "showInputBox"
      | "showErrorMessage"]: (typeof vscode.window)[K];
  };
  const originals = {
    createQuickPick: window.createQuickPick,
    createInputBox: window.createInputBox,
    showInputBox: window.showInputBox,
    showErrorMessage: window.showErrorMessage,
  };

  const pg = (): RunningEngine => {
    assert.ok(engine, "PostgreSQL is not running");
    return engine;
  };

  before(async function () {
    this.timeout(START_DEADLINE_MS + 120_000);
    saved = settings().inspect("connections")?.globalValue;
    await settings().update("connections", [], vscode.ConfigurationTarget.Global);
    const { extensionPath } = await activated();
    engine = await startEngine("postgres", runId, extensionPath);
    await waitForPostgres(engine);
  });

  beforeEach(() => {
    inputs = new ScriptedQuickInputs(vscode.QuickInputButtons.Back);
    boxes = [];
    boxAnswer = undefined;
    errors = [];
    window.createQuickPick = () => inputs.createQuickPick();
    window.createInputBox = () => inputs.createInputBox();
    window.showInputBox = ((options?: vscode.InputBoxOptions) => {
      boxes.push(options?.title ?? "");
      return Promise.resolve(boxAnswer);
    }) as typeof vscode.window.showInputBox;
    window.showErrorMessage = ((message: string) => {
      errors.push(message);
      return Promise.resolve(undefined);
    }) as typeof vscode.window.showErrorMessage;
  });

  afterEach(() => {
    Object.assign(window, originals);
  });

  after(async function () {
    this.timeout(120_000);
    try {
      await settings().update("connections", saved, vscode.ConfigurationTarget.Global);
    } finally {
      if (engine !== undefined) await stopEngine(engine);
      engine = undefined;
    }
  });

  it("reveals and selects the connection Add Connection saved, which then lists its schemas (part 2 criterion 14)", async function () {
    this.timeout(120_000);
    const env = pg().environment;
    const adding = vscode.commands.executeCommand<string>("libredb.addConnection");
    const engines = await Promise.race([
      inputs.nextPick(),
      delay(10_000).then(() => assert.fail("the extension's first quick input never reached the script within 10 s")),
    ]);
    for (const started = Date.now(); engines.items.length === 0; await delay(50)) {
      if (Date.now() - started > 60_000) assert.fail("the engine pick stayed empty for 60 s");
    }
    inputs.choose("PostgreSQL");
    await inputs.nextPick();
    inputs.choose("Enter connection details");
    for (const value of ["127.0.0.1", String(pg().port), env.POSTGRES_USER, env.POSTGRES_PASSWORD, env.POSTGRES_DB]) {
      await inputs.nextBox();
      inputs.accept(value);
    }
    const testing: ScriptedQuickPick<vscode.QuickPickItem> = await inputs.nextPick();
    console.log(`the test pick: ${testing.placeholder}`);
    const name = await inputs.nextBox();
    inputs.accept(name.value);
    const id = await adding;
    assert.match(id, /^[0-9a-z]+$/);

    const { selection } = tree().view;
    assert.deepEqual(
      selection.map((node) => (node as Node).id),
      [`c/${id}`],
    );
    const node = selection[0] as Node;
    const item = await itemOf(node);
    assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.equal(item.description, undefined);
    const containers = await childrenOf(node);
    assert.ok((await labelsOf(containers)).includes("public"), JSON.stringify(await labelsOf(containers)));
    assert.deepEqual(boxes, [], "the add stored the secrets, so the expand asked for none");
    assert.equal((await itemOf(await rootNode(id))).description, "connected");
  });

  it("asks once for a secret this machine never stored, keeps it, and opens nothing on Escape (part 2 criterion 16)", async function () {
    this.timeout(120_000);
    await psql(pg(), `create role pr9_sentinel_user login password '${sentinel}'`);
    const shape = (id: string, name: string) => ({
      id,
      name,
      type: "postgres",
      host: "127.0.0.1",
      port: pg().port,
      user: "pr9_sentinel_user",
      database: pg().environment.POSTGRES_DB,
      createdAt: new Date().toISOString(),
      secretFields: ["password"],
    });
    await settings().update(
      "connections",
      [...savedConnections(), shape(promptedId, "prompted"), shape(declinedId, "declined")],
      vscode.ConfigurationTarget.Global,
    );

    const prompted = await rootNode(promptedId);
    boxAnswer = sentinel;
    const containers = await childrenOf(prompted);
    assert.equal(boxes.length, 1, JSON.stringify(boxes));
    assert.ok((await labelsOf(containers)).includes("public"));
    await delay(2000);
    assert.equal((await itemOf(await rootNode(promptedId))).description, "connected");
    const publicNode = containers[(await labelsOf(containers)).indexOf("public")];
    await vscode.commands.executeCommand("libredb.refresh", publicNode);
    assert.ok((await childrenOf(publicNode)).length > 0);
    assert.equal(boxes.length, 1, "the stored secret's own change event closed the connection");
    assert.equal((await itemOf(await rootNode(promptedId))).description, "connected");

    boxes = [];
    boxAnswer = undefined;
    const declined = await rootNode(declinedId);
    assert.deepEqual(await childrenOf(declined), []);
    assert.equal(boxes.length, 1);
    assert.deepEqual(errors, []);
    assert.equal((await itemOf(await rootNode(declinedId))).description, undefined);
    // Nothing was stored: a refresh on the node asks again.
    await vscode.commands.executeCommand("libredb.refresh", declined);
    assert.deepEqual(await childrenOf(declined), []);
    assert.equal(boxes.length, 2, "the declined secret was stored");
  });

  it("reads a host edit on the next expand, with no Refresh (part 2 criterion 19's tree half)", async function () {
    this.timeout(120_000);
    const node = await rootNode(promptedId);
    assert.equal((await itemOf(node)).description, "connected");
    const withHost = (host: string) =>
      savedConnections().map((entry) => (entry.id === promptedId ? { ...entry, host } : entry));

    let changed = nextChange();
    await settings().update("connections", withHost("127.0.0.2"), vscode.ConfigurationTarget.Global);
    await changed;
    const failed = await childrenOf(node);
    assert.equal(failed.length, 1, JSON.stringify(await labelsOf(failed)));
    const failure = await itemOf(failed[0]);
    console.log(`127.0.0.2 answered: ${failure.label}`);
    assert.equal(failure.contextValue, "libredb;node=error");
    assert.equal((await itemOf(await rootNode(promptedId))).description, "connection failed");

    changed = nextChange();
    await settings().update("connections", withHost("127.0.0.1"), vscode.ConfigurationTarget.Global);
    await changed;
    assert.ok((await labelsOf(await childrenOf(node))).includes("public"));
    assert.deepEqual(boxes, []);
  });

  it("leaves the secret in neither the log nor the child's command line or environment (part 2 criterion 21's open half)", async function () {
    this.timeout(120_000);
    if (process.platform !== "linux") this.skip();
    const logs = filesNamed(join(__dirname, "..", "..", "..", ".vscode-test", "user-data", "logs"), "LibreDB.log");
    assert.ok(logs.length > 0, "no LibreDB.log under the run's user data directory");
    const newest = logs.reduce((a, b) => (statSync(a).mtimeMs >= statSync(b).mtimeMs ? a : b));
    const log = readFileSync(newest, "utf8");
    console.log(`${newest}: ${log.length} characters`);
    assert.equal(log.includes(sentinel), false, `${newest} holds the secret`);
    const children = await backendChildren();
    assert.ok(children.length > 0, "no dist/backend.js child runs");
    for (const { pid } of children) {
      for (const file of ["cmdline", "environ"]) {
        const text = readFileSync(`/proc/${pid}/${file}`, "utf8");
        assert.ok(text.length > 0, `/proc/${pid}/${file} is empty`);
        assert.equal(text.includes(sentinel), false, `/proc/${pid}/${file} holds the secret`);
      }
    }
  });
});
