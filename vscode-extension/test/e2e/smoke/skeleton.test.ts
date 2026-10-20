import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import * as vscode from "vscode";
import { backendForkOptions } from "../../../src/host/fork-options";
import { EXIT_NOTIFICATION, METHODS } from "../../../src/protocol";
import { openSession } from "../../backend-session";
import { FLOOR_NODE } from "../../vscode-floor";
import versions from "../../vscode-versions.json";

const EXTENSION_ID = "libredb.libredb-studio";

describe("the LibreDB extension in a real extension host", () => {
  it("activates and registers libredb.showLog", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not loaded in the test instance`);
    await extension.activate();
    assert.equal(extension.isActive, true);
    assert.ok((await vscode.commands.getCommands(true)).includes("libredb.showLog"));
    await vscode.commands.executeCommand("libredb.showLog");
  });

  it("forks dist/backend.js from the host's own execPath, which answers initialize as Node inside Electron", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not loaded in the test instance`);
    const root = extension.extensionPath;
    const session = openSession(fork(join(root, "dist", "backend.js"), [], backendForkOptions(root)));
    const { runtime } = await session.initialize();
    console.log(
      `VS Code ${vscode.version} on ${process.platform}/${process.arch}: host execPath ${process.execPath}, ` +
        `host ELECTRON_RUN_AS_NODE ${process.env.ELECTRON_RUN_AS_NODE ?? "unset"}, child node ${runtime.node}, electron ${runtime.electron}`,
    );
    assert.match(runtime.electron ?? "", /^\d+\.\d+\.\d+$/);
    assert.equal(runtime.node, process.versions.node);
    if (vscode.version === versions.floor) assert.equal(runtime.node, FLOOR_NODE);
    assert.equal(await session.connection.sendRequest(METHODS.shutdown), null);
    const exited = once(session.child, "exit");
    await session.connection.sendNotification(EXIT_NOTIFICATION);
    const [code] = await exited;
    session.connection.dispose();
    assert.equal(code, 0);
  });
});
