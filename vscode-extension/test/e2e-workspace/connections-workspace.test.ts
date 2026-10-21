// Part 2 criterion 20 in a window with a workspace folder whose .vscode/settings.json sets libredb.connections: the
// setting is application-scoped, so the extension reads the user value alone and never offers the workspace's entry.
// @vscode/test-electron starts every host with --disable-workspace-trust, so this leg checks the trusted half only.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";

const EXTENSION_ID = "libredb.libredb-studio";
const MINE = [
  { id: "mine1", name: "mine", type: "postgres", host: "localhost", createdAt: "2026-10-20T00:00:00.000Z" },
];

const connections = () => vscode.workspace.getConfiguration("libredb");

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

describe("the connections setting in a window whose workspace sets it", () => {
  let saved: unknown[] | undefined;
  let showQuickPick: typeof vscode.window.showQuickPick | undefined;

  before(() => {
    saved = connections().inspect<unknown[]>("connections")?.globalValue;
  });

  afterEach(() => {
    if (showQuickPick !== undefined) {
      (vscode.window as { showQuickPick: unknown }).showQuickPick = showQuickPick;
      showQuickPick = undefined;
    }
  });

  after(async function () {
    this.timeout(60_000);
    await writeUserConnections(saved);
  });

  it("reads the user value alone, and Remove never offers the workspace's entry", async function () {
    this.timeout(120_000);
    console.log(`VS Code ${vscode.version}: workspace.isTrusted is ${vscode.workspace.isTrusted}`);
    assert.equal(vscode.workspace.isTrusted, true);
    assert.equal(vscode.workspace.workspaceFolders?.[0]?.name, "fixture");
    console.log(`the workspace value: ${JSON.stringify(connections().inspect("connections")?.workspaceValue)}`);
    await writeUserConnections(MINE);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not loaded in the test instance`);
    await extension.activate();
    assert.deepEqual(connections().get("connections"), MINE);
    const offered: string[][] = [];
    showQuickPick = vscode.window.showQuickPick;
    (vscode.window as { showQuickPick: unknown }).showQuickPick = (items: readonly vscode.QuickPickItem[]) => {
      offered.push(items.map((item) => item.label));
      return Promise.resolve(undefined);
    };
    assert.equal(await vscode.commands.executeCommand("libredb.removeConnection"), false);
    assert.deepEqual(offered, [["mine"]]);
  });
});
