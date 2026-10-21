import { fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { newLocalId } from "@/lib/ids";
import { BackendClient } from "./backend-client";
import { BackendSupervisor } from "./backend-supervisor";
import { type AddConnectionDeps, addConnection, cachedCatalog } from "./connections/add-connection-ui";
import { ProfileConnectionSource } from "./connections/connection-source";
import { ConnectionStore, connectionsSetting } from "./connections/connection-store";
import { type RemoveDeps, releaseOnChange, removeConnection } from "./connections/remove-connection";
import { COMMANDS, CONNECTIONS_VIEW } from "./names";
import { OpenConnections } from "./open-connections";
import { ConnectionsTree } from "./tree/connections-tree";
import { EngineIcons, readEngineIndex } from "./tree/icons";
import { refreshTarget } from "./tree/nodes";

/** The backend child's supervisor, from activate until deactivate; it starts nothing until the first backend call. */
let supervisor: BackendSupervisor | undefined;

/**
 * Reads the engine index the build wrote, creates the LibreDB log channel, registers the command that shows it, creates
 * the backend supervisor, reads the libredb.connections setting into the connection store, creates the Connections view
 * on its tree, and registers Add Connection, Remove Connection and Refresh.
 * Reading the setting needs no backend and the tree's root reads the store only, so activation starts no child (part 2
 * criterion 1). A missing or unreadable index is a broken install and throws before anything is registered.
 * It returns nothing, so no other extension can reach the backend and run statements on the person's connections.
 */
export function activate(context: vscode.ExtensionContext): void {
  const index = readEngineIndex(readFileSync(join(context.extensionPath, "media", "engines", "index.json"), "utf8"));
  const log = vscode.window.createOutputChannel("LibreDB", { log: true });
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand(COMMANDS.showLog, () => log.show()),
  );
  const showLog = () => vscode.commands.executeCommand(COMMANDS.showLog);
  const openUserSettings = () => vscode.commands.executeCommand("workbench.action.openSettingsJson");
  supervisor = new BackendSupervisor({
    fork,
    extensionPath: context.extensionPath,
    log,
    window: vscode.window,
    showLog,
  });
  const setting = connectionsSetting(vscode.workspace);
  const store = new ConnectionStore({ setting, secrets: context.secrets, log });
  const opened = new OpenConnections();
  const client = new BackendClient(
    supervisor,
    new ProfileConnectionSource({ store, window: vscode.window, workspace: vscode.workspace }),
    opened,
  );
  const tree = new ConnectionsTree({
    store,
    client,
    opened,
    link: supervisor,
    icons: new EngineIcons(context.extensionUri, index),
    window: vscode.window,
  });
  const view = vscode.window.createTreeView(CONNECTIONS_VIEW, {
    treeDataProvider: tree,
    showCollapseAll: true,
    canSelectMany: false,
  });
  tree.attach(view);
  const adding: AddConnectionDeps = {
    client,
    catalog: cachedCatalog(() => client.listEngines({})),
    store,
    window: vscode.window,
    workspace: vscode.workspace,
    showLog,
    openUserSettings,
    newId: newLocalId,
    now: () => new Date(),
    reveal: (id) => tree.revealConnection(id),
  };
  const removing: RemoveDeps = { store, client, window: vscode.window, log, openUserSettings };
  context.subscriptions.push(
    setting,
    store,
    opened,
    tree,
    view,
    vscode.commands.registerCommand(COMMANDS.addConnection, () => addConnection(adding)),
    vscode.commands.registerCommand(COMMANDS.removeConnection, (target?: unknown) =>
      removeConnection(removing, target),
    ),
    // With no argument the setting is read again and every cache dropped; on a node, only that node's subtree.
    vscode.commands.registerCommand(COMMANDS.refresh, (target?: unknown) => {
      const node = refreshTarget(target);
      if (node !== undefined) return tree.refresh(node);
      store.reload();
      tree.refresh();
    }),
    releaseOnChange(store, client, log),
  );
}

/** The supervisor's stop(), which VS Code awaits as an asynchronous cleanup (activation-events.md). */
export function deactivate(): Promise<void> | undefined {
  const stopping = supervisor?.stop();
  supervisor = undefined;
  return stopping;
}
