import assert from "node:assert/strict";
import type * as vscode from "vscode";
import { activate } from "../../src/host/extension";
import { commands, fakeExtensionContext, outputChannels, registeredCommands } from "../fakes/vscode";

describe("activate", () => {
  it("creates the LibreDB log channel and registers libredb.showLog", () => {
    const context = fakeExtensionContext();
    activate(context as vscode.ExtensionContext);
    assert.deepEqual(
      outputChannels.map((channel) => [channel.name, channel.options]),
      [["LibreDB", { log: true }]],
    );
    assert.deepEqual([...registeredCommands.keys()], ["libredb.showLog"]);
    assert.equal(context.subscriptions.length, 2);
  });

  it("shows the log channel when libredb.showLog runs", async () => {
    activate(fakeExtensionContext() as vscode.ExtensionContext);
    await commands.executeCommand("libredb.showLog");
    assert.equal(outputChannels[0].shown, 1);
  });

  it("releases the channel and the command when its subscriptions are disposed", () => {
    const context = fakeExtensionContext();
    activate(context as vscode.ExtensionContext);
    for (const subscription of context.subscriptions) subscription.dispose();
    assert.equal(outputChannels[0].disposed, true);
    assert.equal(registeredCommands.has("libredb.showLog"), false);
  });
});
