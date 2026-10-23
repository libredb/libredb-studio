// The Connections view's root in a real extension host (part 3 criteria 1 and 2, part 2 criteria 1 and 15): no Docker,
// so it runs in the macOS and Windows smoke jobs too.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { connectionsTree, installTreeCapture } from "../tree-capture";

const EXTENSION_ID = "libredb.libredb-studio";
const execFileAsync = promisify(execFile);

installTreeCapture();
const ACTIVE_AT_LOAD = vscode.extensions.getExtension(EXTENSION_ID)?.isActive;

/** The command lines of this extension host's children that run dist/backend.js; Linux only. */
async function backendChildren(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pid=,args=", "--ppid", String(process.pid)]);
    return stdout.split("\n").filter((line) => line.includes("dist/backend.js"));
  } catch (error) {
    // ps exits 1, printing nothing, when the process has no children at all.
    if ((error as { code?: unknown; stdout?: unknown }).code === 1 && (error as { stdout?: unknown }).stdout === "") {
      return [];
    }
    throw error;
  }
}

/**
 * The extension's backend children are the same before and after the step: reading the root starts none. On a host
 * where no earlier file opened a connection through the extension, which the smoke subset is, there are none at all.
 */
async function startsNoChild(before: readonly string[], step: string): Promise<void> {
  if (process.platform !== "linux") {
    console.log(`${process.platform}: the dist/backend.js child check runs on Linux only (${step})`);
    return;
  }
  assert.deepEqual(await backendChildren(), before, step);
}

async function activated(): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not loaded in the test instance`);
  await extension.activate();
  return extension;
}

const userConnections = () => vscode.workspace.getConfiguration("libredb");

/** Writes libredb.connections to user settings, then waits until the root reads it. */
async function writeConnections(value: readonly unknown[], labels: readonly string[]): Promise<unknown[]> {
  await userConnections().update("connections", value, vscode.ConfigurationTarget.Global);
  const started = Date.now();
  for (;;) {
    const root = ((await connectionsTree().provider.getChildren()) ?? []) as unknown[];
    const read = await Promise.all(
      root.map(async (node) => (await connectionsTree().provider.getTreeItem(node)).label),
    );
    if (JSON.stringify(read) === JSON.stringify(labels)) return root;
    if (Date.now() - started > 5000)
      assert.fail(`the root reads ${JSON.stringify(read)}, not ${JSON.stringify(labels)}`);
    await delay(50);
  }
}

describe("the Connections view's root in a real extension host", () => {
  let saved: unknown;
  let childrenBefore: string[] = [];

  before(async () => {
    saved = userConnections().inspect("connections")?.globalValue;
    childrenBefore = process.platform === "linux" ? await backendChildren() : [];
    console.log(
      `the extension was active when this file loaded: ${ACTIVE_AT_LOAD}; LIBREDB_E2E_SUBSET ${process.env.LIBREDB_E2E_SUBSET ?? "unset"}; ` +
        `backend children before: ${JSON.stringify(childrenBefore)}`,
    );
  });

  after(async () => {
    await userConnections().update("connections", saved, vscode.ConfigurationTarget.Global);
  });

  it("is empty with no connection, offers the welcome content, and starts no child (part 3 criterion 1)", async function () {
    this.timeout(120_000);
    const extension = await activated();
    const { provider } = connectionsTree();
    await writeConnections([], []);
    assert.deepEqual(await provider.getChildren(), []);
    assert.deepEqual((extension.packageJSON as { contributes: { viewsWelcome: unknown } }).contributes.viewsWelcome, [
      {
        view: "libredb.connections",
        contents: "No connections yet.\n[Add Connection](command:libredb.addConnection)",
      },
    ]);
    if (process.env.LIBREDB_E2E_SUBSET === "smoke" && process.platform === "linux") {
      // No file of the smoke subset opens a connection through the extension, so its host has no backend child.
      assert.deepEqual(childrenBefore, []);
    }
    await startsNoChild(childrenBefore, "after activation and an empty root");
  });

  it("lists saved connections in setting order with their logos, and an invalid entry in place (part 3 criterion 2)", async function () {
    this.timeout(120_000);
    await activated();
    const { provider } = connectionsTree();
    const root = await writeConnections(
      [
        {
          id: "e2eshop1",
          name: "shop",
          type: "postgres",
          host: "localhost",
          port: 5432,
          user: "app",
          database: "shop",
          createdAt: "2026-10-20T00:00:00.000Z",
        },
        {
          id: "e2eorders1",
          name: "orders",
          type: "mongodb",
          database: "orders",
          createdAt: "2026-10-20T00:00:00.000Z",
        },
        { id: "bad1", name: "bad", type: "nosuchdb", createdAt: "2026-10-20T00:00:00.000Z" },
      ],
      ["shop", "orders", "bad"],
    );
    const items = await Promise.all(root.map(async (node) => await provider.getTreeItem(node)));
    for (const item of items.slice(0, 2)) {
      const icon = item.iconPath as { light: vscode.Uri; dark: vscode.Uri };
      for (const uri of [icon.light, icon.dark]) {
        assert.equal(uri.scheme, "file");
        assert.ok(existsSync(uri.fsPath), `${uri.fsPath} does not exist`);
      }
    }
    const bad = items[2];
    assert.equal(bad.description, "invalid");
    assert.equal(
      bad.tooltip,
      "The connection bad has the type nosuchdb, which is not a database LibreDB Studio connects to.",
    );
    assert.ok(bad.iconPath instanceof vscode.ThemeIcon);
    assert.equal(bad.iconPath.id, "error");
    assert.equal(bad.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.deepEqual(await provider.getChildren(root[2]), []);
    await startsNoChild(childrenBefore, "after listing three entries");
  });
});
