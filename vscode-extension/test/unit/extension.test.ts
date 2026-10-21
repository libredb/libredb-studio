import assert from "node:assert/strict";
import type * as vscode from "vscode";
import { activate, deactivate } from "../../src/host/extension";
import { MONGO, PG } from "../fakes/profiles";
import {
  answerMessages,
  answerQuickPicks,
  changeConfiguration,
  commands,
  configurationReads,
  fakeExtensionContext,
  outputChannels,
  registeredCommands,
  settings,
  shownQuickPicks,
} from "../fakes/vscode";
import { TEST_PASSWORD } from "../fakes/credentials";

const COMMANDS = ["libredb.showLog", "libredb.addConnection", "libredb.removeConnection", "libredb.refresh"];

/** The labels Remove Connection's palette offers, dismissed. */
async function palette(remove = () => commands.executeCommand("libredb.removeConnection")): Promise<string[]> {
  await remove();
  return (shownQuickPicks.at(-1)?.items ?? []).map((item) => item.label);
}

describe("activate", () => {
  afterEach(async () => {
    await deactivate();
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
    // The channel, its command, the setting adapter, the store, three commands and the release.
    assert.equal(context.subscriptions.length, 8);
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
