import * as vscode from "vscode";

/** Creates the LibreDB log channel and registers the command that shows it. */
export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("LibreDB", { log: true });
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand("libredb.showLog", () => log.show()),
  );
}
