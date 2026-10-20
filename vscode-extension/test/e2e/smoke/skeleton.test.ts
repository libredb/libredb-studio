import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import * as vscode from "vscode";
import type { RuntimeAnswer } from "../../../src/backend/start";
import { firstAnswer } from "../../child-answer";
import { backendForkOptions } from "../../fork-options";
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

  it("forks dist/backend.js from the host's own execPath, which answers as Node inside Electron", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not loaded in the test instance`);
    const root = extension.extensionPath;
    const child = fork(join(root, "dist", "backend.js"), [], backendForkOptions(root));
    const answer = (await firstAnswer(child)) as RuntimeAnswer;
    console.log(
      `VS Code ${vscode.version} on ${process.platform}/${process.arch}: host execPath ${process.execPath}, ` +
        `host ELECTRON_RUN_AS_NODE ${process.env.ELECTRON_RUN_AS_NODE ?? "unset"}, child node ${answer.versions.node}, electron ${answer.versions.electron}`,
    );
    assert.match(answer.versions.electron ?? "", /^\d+\.\d+\.\d+$/);
    assert.equal(answer.versions.node, process.versions.node);
    if (vscode.version === versions.floor) assert.equal(answer.versions.node, FLOOR_NODE);
    child.disconnect();
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
  });
});
