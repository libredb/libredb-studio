// The connection commands in a real extension host (part 2 criteria 1, 4, 13, 17 and 21): the test sets the window's
// quick input functions to scripted doubles, which the extension's commands reach because a test file inside the
// extension's folder gets the same vscode API object as dist/extension.js.
// It runs in the workspace configuration's host, not beside test/e2e/backend-lifecycle.test.ts: both need a host whose
// extension has started no child yet, and Add Connection leaves the extension's own child running. It needs Docker for
// PostgreSQL, so the smoke subset leaves it out.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { REMOVE } from "../../src/host/connections/remove-connection";
import { ScriptedQuickInputs, type ScriptedQuickPick } from "../fakes/quick-input";
import { psql, type RunningEngine, START_DEADLINE_MS, startEngine, stopEngine } from "../integration/containers";

const EXTENSION_ID = "libredb.libredb-studio";
const execFileAsync = promisify(execFile);
const SENTINEL_USER = "pr8_sentinel_user";
/** The window functions the doubles stand in for. */
type Patched = "createQuickPick" | "createInputBox" | "showQuickPick" | "showWarningMessage";

/** The window object the extension reads its quick input functions from, writable for the doubles. */
const window = vscode.window as unknown as Record<Patched, unknown>;

async function installedExtension(): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not loaded in the test instance`);
  await extension.activate();
  return extension;
}

/** The pid and command line of each child of this extension host that runs dist/backend.js. */
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

const connections = () => vscode.workspace.getConfiguration("libredb");
const userConnections = () => connections().inspect<unknown[]>("connections")?.globalValue;

/** Writes libredb.connections to user settings and resolves once the change event for it has fired. */
async function writeUserConnections(value: unknown[] | undefined): Promise<void> {
  const changed = new Promise<void>((resolve) => {
    const listener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("libredb.connections")) return;
      listener.dispose();
      resolve();
    });
  });
  await connections().update("connections", value, vscode.ConfigurationTarget.Global);
  await Promise.race([changed, delay(2000)]);
}

/** Every file under dir named name, newest first. */
function filesNamed(dir: string, name: string): string[] {
  const found: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === name) found.push(path);
    }
  };
  walk(dir);
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** Resolves once the pick is no longer busy, as the engine pick fills once the catalogue is in. */
async function settled(pick: ScriptedQuickPick<vscode.QuickPickItem>): Promise<void> {
  const started = Date.now();
  while (pick.busy || pick.items.length === 0) {
    if (Date.now() - started > 30_000) assert.fail(`the pick ${pick.title} stayed busy for 30 s`);
    await delay(50);
  }
}

describe("the connection commands in a real extension host", () => {
  const runId = `${process.pid}-${Date.now()}`;
  const sentinel = `pr8-sentinel-${runId}`;
  let saved: unknown[] | undefined;
  let engine: RunningEngine | undefined;
  let originals: Partial<Record<Patched, unknown>> = {};
  let extensionPath: string;
  let addedId: string | undefined;

  /** Sets the window's functions to the doubles given, keeping the real ones for afterEach. */
  function patch(doubles: Partial<Record<Patched, unknown>>): void {
    for (const [name, double] of Object.entries(doubles) as [Patched, unknown][]) {
      originals[name] ??= window[name];
      window[name] = double;
      assert.equal(window[name], double, `vscode.window.${name} did not take the double`);
    }
  }

  before(async function () {
    this.timeout(START_DEADLINE_MS + 60_000);
    saved = userConnections();
    extensionPath = vscode.extensions.getExtension(EXTENSION_ID)?.extensionPath ?? assert.fail("no extension");
    engine = await startEngine("postgres", runId, extensionPath);
    const started = Date.now();
    for (;;) {
      try {
        await psql(engine, `create role ${SENTINEL_USER} login password '${sentinel}'`);
        break;
      } catch (error) {
        if (Date.now() - started > START_DEADLINE_MS) throw error;
        await delay(1000);
      }
    }
  });

  afterEach(() => {
    for (const [name, original] of Object.entries(originals)) window[name as Patched] = original;
    originals = {};
  });

  after(async function () {
    this.timeout(60_000);
    try {
      await writeUserConnections(saved);
    } finally {
      if (engine !== undefined) await stopEngine(engine);
      engine = undefined;
    }
  });

  it("reads the setting on activation, and offers its entries to Remove, with no backend child", async function () {
    this.timeout(120_000);
    await writeUserConnections([
      { id: "e2efirst", name: "first", type: "postgres", host: "localhost", createdAt: "2026-10-20T00:00:00.000Z" },
      { id: "e2esecond", name: "second", type: "mysql", host: "localhost", createdAt: "2026-10-20T00:00:00.000Z" },
    ]);
    await installedExtension();
    assert.deepEqual(await backendChildren(), []);
    const offered: string[][] = [];
    patch({
      showQuickPick: (items: readonly vscode.QuickPickItem[]) => {
        offered.push(items.map((item) => item.label));
        return Promise.resolve(undefined);
      },
    });
    assert.equal(await vscode.commands.executeCommand("libredb.removeConnection"), false);
    assert.deepEqual(offered, [["first", "second"]]);
    assert.deepEqual(await backendChildren(), []);
  });

  it("adds a PostgreSQL connection by details through the quick inputs, keeping the password out of the setting", async function () {
    this.timeout(120_000);
    assert.ok(engine);
    const before = userConnections() ?? [];
    const screen = new ScriptedQuickInputs(vscode.QuickInputButtons.Back);
    patch({
      createQuickPick: () => screen.createQuickPick(),
      createInputBox: () => screen.createInputBox(),
    });
    const adding = vscode.commands.executeCommand<string | undefined>("libredb.addConnection");
    const first = await Promise.race([screen.nextPick(), delay(10_000).then(() => undefined)]);
    assert.ok(first, "the extension's first quick input did not reach the script within 10 s");
    await settled(first);
    screen.choose("PostgreSQL");
    await screen.nextPick();
    screen.choose("Enter connection details");
    const typed = ["127.0.0.1", String(engine.port), SENTINEL_USER, sentinel, "postgres"];
    const boxes: { title: string | undefined; password: boolean }[] = [];
    for (const value of typed) {
      const box = await screen.nextBox();
      boxes.push({ title: box.title, password: box.password });
      screen.accept(value);
    }
    const testing = await screen.nextPick();
    const testingBusy = testing.busy;
    const name = await screen.nextBox();
    const offeredName = name.value;
    screen.accept(offeredName);
    addedId = await adding;
    console.log(
      `VS Code ${vscode.version}: the add walk showed ${screen.shown.map((input) => input.title).join(" | ")}`,
    );
    assert.deepEqual(
      boxes.map(({ title, password }) => [title?.split(": ").at(-1), password]),
      [
        ["Host", false],
        ["Port", false],
        ["User", false],
        ["Password", true],
        ["Database", false],
      ],
    );
    assert.equal(testingBusy, true);
    assert.match(name.prompt ?? "", /^Connected in \d+ ms\. Name this connection\.$/);
    assert.equal(screen.shown.length, 9);
    assert.equal(offeredName, "postgres");
    assert.match(addedId ?? "", /^[0-9a-z]+$/);
    const after = userConnections() ?? [];
    assert.deepEqual(after.slice(0, before.length), before);
    assert.equal(after.length, before.length + 1);
    const added = after.at(-1) as Record<string, unknown>;
    assert.equal(typeof added.createdAt, "string");
    assert.equal(new Date(added.createdAt as string).toISOString(), added.createdAt);
    assert.deepEqual(added, {
      id: addedId,
      name: "postgres",
      type: "postgres",
      host: "127.0.0.1",
      port: engine.port,
      user: SENTINEL_USER,
      database: "postgres",
      createdAt: added.createdAt,
      secretFields: ["password"],
    });
    assert.ok(!("password" in added));
  });

  it("removes the added connection from the palette after the modal warning", async function () {
    this.timeout(120_000);
    assert.ok(addedId, "the add case saved no connection");
    const warnings: unknown[][] = [];
    patch({
      showQuickPick: (items: readonly vscode.QuickPickItem[]) =>
        Promise.resolve(items.find((item) => item.label === "postgres")),
      showWarningMessage: (...args: unknown[]) => {
        warnings.push(args);
        return Promise.resolve(REMOVE);
      },
    });
    assert.equal(await vscode.commands.executeCommand("libredb.removeConnection"), true);
    assert.deepEqual(warnings, [
      [
        "Remove the connection postgres?",
        {
          modal: true,
          detail: "Its secrets are deleted from this machine's secret storage. Editors bound to it stay open, unbound.",
        },
        REMOVE,
      ],
    ]);
    const left = (userConnections() ?? []) as { id?: unknown }[];
    assert.ok(!left.some((entry) => entry.id === addedId), JSON.stringify(left));
  });

  it("writes the password to no log line, and hands it to the child neither in argv nor in its environment", async function () {
    this.timeout(60_000);
    const logs = filesNamed(join(extensionPath, ".vscode-test", "user-data", "logs"), "LibreDB.log");
    assert.ok(logs.length > 0, "no LibreDB.log under .vscode-test/user-data/logs");
    const log = readFileSync(logs[0], "utf8");
    console.log(`${logs[0]}: ${log.length} characters`);
    assert.ok(!log.includes(sentinel), `${logs[0]} holds the password`);
    const children = await backendChildren();
    assert.equal(children.length, 1, JSON.stringify(children));
    for (const file of ["cmdline", "environ"]) {
      const content = readFileSync(`/proc/${children[0].pid}/${file}`, "utf8");
      assert.ok(content.length > 0, `/proc/${children[0].pid}/${file} is empty`);
      assert.ok(!content.includes(sentinel), `the child's ${file} holds the password`);
    }
  });
});
