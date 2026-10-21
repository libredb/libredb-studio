import { fork } from "node:child_process";
import * as vscode from "vscode";
import { newLocalId } from "@/lib/ids";
import { BackendClient } from "./backend-client";
import { BackendSupervisor } from "./backend-supervisor";
import { type AddConnectionDeps, addConnection, cachedCatalog } from "./connections/add-connection-ui";
import { ProfileConnectionSource } from "./connections/connection-source";
import { ConnectionStore, connectionsSetting } from "./connections/connection-store";
import { type RemoveDeps, releaseOnChange, removeConnection } from "./connections/remove-connection";

/** The backend child's supervisor, from activate until deactivate; it starts nothing until the first backend call. */
let supervisor: BackendSupervisor | undefined;

/**
 * Creates the LibreDB log channel, registers the command that shows it, creates the backend supervisor, reads the
 * libredb.connections setting into the connection store, and registers Add Connection, Remove Connection and Refresh.
 * Reading the setting needs no backend, so activation starts no child (part 2 criterion 1).
 * It returns nothing, so no other extension can reach the backend and run statements on the person's connections.
 */
export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("LibreDB", { log: true });
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand("libredb.showLog", () => log.show()),
  );
  const showLog = () => vscode.commands.executeCommand("libredb.showLog");
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
  const client = new BackendClient(
    supervisor,
    new ProfileConnectionSource({ store, window: vscode.window, workspace: vscode.workspace }),
  );
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
  };
  const removing: RemoveDeps = { store, client, window: vscode.window, log, openUserSettings };
  context.subscriptions.push(
    setting,
    store,
    vscode.commands.registerCommand("libredb.addConnection", () => addConnection(adding)),
    vscode.commands.registerCommand("libredb.removeConnection", (target?: unknown) =>
      removeConnection(removing, target),
    ),
    // PR 9 adds the tree's refresh to the same command.
    vscode.commands.registerCommand("libredb.refresh", () => store.reload()),
    releaseOnChange(store, client, log),
  );
}

/** The supervisor's stop(), which VS Code awaits as an asynchronous cleanup (activation-events.md). */
export function deactivate(): Promise<void> | undefined {
  const stopping = supervisor?.stop();
  supervisor = undefined;
  return stopping;
}
