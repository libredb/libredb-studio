import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";
import { activate, deactivate } from "../../src/host/extension";
import { ConnectionsTree } from "../../src/host/tree/connections-tree";
import type { TreeNode } from "../../src/host/tree/nodes";
import { MONGO, PG } from "../fakes/profiles";
import {
  answerMessages,
  answerQuickPicks,
  changeConfiguration,
  commands,
  configurationReads,
  fakeExtensionContext as fakeContextAt,
  outputChannels,
  registeredCommands,
  settings,
  shownQuickPicks,
  treeViews,
} from "../fakes/vscode";
import { TEST_PASSWORD } from "../fakes/credentials";

const COMMANDS = ["libredb.showLog", "libredb.addConnection", "libredb.removeConnection", "libredb.refresh"];

/** The labels Remove Connection's palette offers, dismissed. */
async function palette(remove = () => commands.executeCommand("libredb.removeConnection")): Promise<string[]> {
  await remove();
  return (shownQuickPicks.at(-1)?.items ?? []).map((item) => item.label);
}

/** An extension directory holding the media/engines/index.json the build writes, for every test of this file. */
let extensionPath: string;

before(() => {
  extensionPath = mkdtempSync(join(tmpdir(), "libredb-extension-"));
  mkdirSync(join(extensionPath, "media", "engines"), { recursive: true });
  writeFileSync(
    join(extensionPath, "media", "engines", "index.json"),
    JSON.stringify({ postgres: { label: "PostgreSQL" }, mongodb: { label: "MongoDB" } }),
  );
});

after(() => {
  rmSync(extensionPath, { recursive: true, force: true });
});

const fakeExtensionContext = () => fakeContextAt(extensionPath);

/** The Connections tree activate gave its view, and every event it fired from now on. */
function connectionsTree(): { tree: ConnectionsTree; fired: (TreeNode | undefined)[] } {
  const tree = treeViews[0].options.treeDataProvider as ConnectionsTree;
  const fired: (TreeNode | undefined)[] = [];
  tree.onDidChangeTreeData((node) => fired.push(node));
  return { tree, fired };
}

describe("activate", () => {
  afterEach(async () => {
    await deactivate();
  });

  it("creates the Connections view on a ConnectionsTree whose root lists the saved connections (part 3 criterion 2)", async () => {
    settings.set("libredb.connections", [PG, MONGO]);
    activate(fakeExtensionContext() as vscode.ExtensionContext);
    assert.equal(treeViews.length, 1);
    const [view] = treeViews;
    assert.equal(view.viewId, "libredb.connections");
    assert.equal(view.options.showCollapseAll, true);
    assert.equal(view.options.canSelectMany, false);
    assert.ok(view.options.treeDataProvider instanceof ConnectionsTree);
    const root = await connectionsTree().tree.getChildren();
    assert.deepEqual(
      root.map((node) => node.id),
      [`c/${PG.id}`, `c/${MONGO.id}`],
    );
  });

  it("refreshes the setting and the whole tree on Refresh with no argument, and only the node on a node", async () => {
    settings.set("libredb.connections", [PG]);
    activate(fakeExtensionContext() as vscode.ExtensionContext);
    const { tree, fired } = connectionsTree();
    const reads = configurationReads.length;
    await commands.executeCommand("libredb.refresh");
    assert.equal(configurationReads.length, reads + 1);
    assert.deepEqual(fired, [undefined]);
    const [pg] = await tree.getChildren();
    await commands.executeCommand("libredb.refresh", pg);
    assert.deepEqual(fired, [undefined, pg]);
    assert.equal(configurationReads.length, reads + 1);
    await assert.rejects(Promise.resolve(commands.executeCommand("libredb.refresh", "x")), {
      message: "libredb.refresh takes a tree node or nothing.",
    });
  });

  it("removes an invalid entry with an id from its tree node", async () => {
    settings.set("libredb.connections", [PG, { id: "bad1", name: "bad" }]);
    activate(fakeExtensionContext() as vscode.ExtensionContext);
    const [, invalid] = await connectionsTree().tree.getChildren();
    assert.equal(invalid.node, "invalid");
    answerMessages(() => "Remove");
    await commands.executeCommand("libredb.removeConnection", invalid);
    assert.deepEqual(settings.get("libredb.connections"), [PG]);
  });

  it("throws an error naming the engine index when the install has none", () => {
    const missing = join(extensionPath, "nowhere");
    const index = join(missing, "media", "engines", "index.json");
    assert.throws(
      () => activate(fakeContextAt(missing) as vscode.ExtensionContext),
      (error: Error) => error.message.includes(index),
    );
  });

  it("disposes the view and the tree with its subscriptions", () => {
    settings.set("libredb.connections", [PG]);
    const context = fakeExtensionContext();
    activate(context as vscode.ExtensionContext);
    const { fired } = connectionsTree();
    for (const subscription of context.subscriptions) subscription.dispose();
    assert.equal(treeViews[0].disposed, true);
    settings.set("libredb.connections", [PG, MONGO]);
    changeConfiguration("libredb.connections");
    assert.deepEqual(fired, []);
  });

  it("creates the LibreDB log channel, registers the four commands and reads the setting once", () => {
    const context = fakeExtensionContext();
    activate(context as vscode.ExtensionContext);
    assert.deepEqual(
      outputChannels.map((channel) => [channel.name, channel.options]),
      [["LibreDB", { log: true }]],
    );
    assert.deepEqual([...registeredCommands.keys()], COMMANDS);
    assert.deepEqual(configurationReads, ["libredb.connections"]);
    // The channel, its command, the setting adapter, the store, the descriptions, the tree, its view, three commands
    // and the release.
    assert.equal(context.subscriptions.length, 11);
  });

  it("re-reads the setting on Refresh", async () => {
    settings.set("libredb.connections", [PG]);
    activate(fakeExtensionContext() as vscode.ExtensionContext);
    settings.set("libredb.connections", [PG, MONGO]);
    assert.deepEqual(await palette(), ["shop"]);
    await commands.executeCommand("libredb.refresh");
    assert.deepEqual(await palette(), ["shop", "orders"]);
  });

  it("picks up a change of libredb.connections without Refresh", async () => {
    settings.set("libredb.connections", [PG]);
    activate(fakeExtensionContext() as vscode.ExtensionContext);
    settings.set("libredb.connections", [PG, MONGO]);
    changeConfiguration("libredb.connections");
    assert.deepEqual(await palette(), ["shop", "orders"]);
  });

  it("removes a connection and its secrets through the wiring, with no backend", async () => {
    const key = `connection/${PG.id}/password`;
    const context = fakeExtensionContext();
    await context.secrets.store(key, TEST_PASSWORD);
    settings.set("libredb.connections", [PG, MONGO]);
    activate(context as vscode.ExtensionContext);
    answerQuickPicks((shown) => shown.items.find((item) => item.label === "shop"));
    answerMessages(() => "Remove");
    assert.equal(await commands.executeCommand("libredb.removeConnection"), true);
    assert.deepEqual(settings.get("libredb.connections"), [MONGO]);
    assert.equal(await context.secrets.get(key), undefined);
  });

  it("shows the log channel when libredb.showLog runs", async () => {
    activate(fakeExtensionContext() as vscode.ExtensionContext);
    await commands.executeCommand("libredb.showLog");
    assert.equal(outputChannels[0].shown, 1);
  });

  it("releases the channel, the commands and the setting's listeners when its subscriptions are disposed", async () => {
    settings.set("libredb.connections", [PG]);
    const context = fakeExtensionContext();
    activate(context as vscode.ExtensionContext);
    const remove = registeredCommands.get("libredb.removeConnection") as () => Promise<boolean>;
    for (const subscription of context.subscriptions) subscription.dispose();
    assert.equal(outputChannels[0].disposed, true);
    assert.deepEqual([...registeredCommands.keys()], []);
    settings.set("libredb.connections", [PG, MONGO]);
    changeConfiguration("libredb.connections");
    assert.deepEqual(await palette(remove), ["shop"]);
  });
});

describe("deactivate", () => {
  afterEach(async () => {
    await deactivate();
  });

  it("has nothing to stop before activate", () => {
    assert.equal(deactivate(), undefined);
  });

  it("returns the backend supervisor's stop, which resolves when no backend was started", async () => {
    assert.equal(activate(fakeExtensionContext() as vscode.ExtensionContext), undefined);
    const stopped = deactivate();
    assert.ok(stopped instanceof Promise);
    await stopped;
    assert.equal(deactivate(), undefined);
  });
});
