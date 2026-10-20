import { fork } from "node:child_process";
import * as vscode from "vscode";
import { BackendSupervisor } from "./backend-supervisor";

/** The backend child's supervisor, from activate until deactivate; it starts nothing until the first backend call. */
let supervisor: BackendSupervisor | undefined;

/**
 * Creates the LibreDB log channel, registers the command that shows it, and creates the backend supervisor.
 * It returns nothing, so no other extension can reach the backend and run statements on the person's connections.
 */
export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("LibreDB", { log: true });
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand("libredb.showLog", () => log.show()),
  );
  supervisor = new BackendSupervisor({
    fork,
    extensionPath: context.extensionPath,
    log,
    window: vscode.window,
    showLog: () => vscode.commands.executeCommand("libredb.showLog"),
  });
}

/** The supervisor's stop(), which VS Code awaits as an asynchronous cleanup (activation-events.md). */
export function deactivate(): Promise<void> | undefined {
  const stopping = supervisor?.stop();
  supervisor = undefined;
  return stopping;
}
