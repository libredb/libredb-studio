// The status bar item of the active editor's connection (part 3, "Status bar item").
import * as vscode from "vscode";
import type { ConnectionStore } from "../connections/connection-store";
import { COMMANDS, STATUS_ITEM } from "../names";
import type { EngineIcons } from "../tree/icons";
import type { BindingStore } from "./bindings";
import type { RunRegistry } from "./run-registry";

/** The item's name in the status bar's own menu. */
export const STATUS_ITEM_NAME = "LibreDB Connection";

export interface StatusBarDeps {
  readonly window: Pick<
    typeof vscode.window,
    "createStatusBarItem" | "activeTextEditor" | "onDidChangeActiveTextEditor"
  >;
  readonly bindings: Pick<BindingStore, "get" | "onDidChange">;
  readonly runs: Pick<RunRegistry, "of" | "onDidChange">;
  readonly store: Pick<ConnectionStore, "get" | "onDidChange">;
  readonly icons: Pick<EngineIcons, "label">;
}

/**
 * `$(database) <name>`, with ` (<catalog>)` when the binding has one, for a bound active document whose connection is a
 * valid profile; the spinner in place of the database icon while the document holds a run; hidden otherwise.
 * Clicking it runs Change Connection on the active editor.
 */
export class ConnectionStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly listeners: vscode.Disposable[];

  constructor(private readonly deps: StatusBarDeps) {
    this.item = deps.window.createStatusBarItem(STATUS_ITEM, vscode.StatusBarAlignment.Right, 100);
    this.item.name = STATUS_ITEM_NAME;
    this.item.command = COMMANDS.changeConnection;
    const refresh = () => this.refresh();
    this.listeners = [
      deps.window.onDidChangeActiveTextEditor(refresh),
      deps.bindings.onDidChange(refresh),
      deps.runs.onDidChange(refresh),
      deps.store.onDidChange(refresh),
    ];
    this.refresh();
  }

  /** Shows the item for a bound active document, hides it otherwise. */
  refresh(): void {
    const document = this.deps.window.activeTextEditor?.document;
    const uri = document?.uri.toString();
    const binding = uri === undefined ? undefined : this.deps.bindings.get(uri);
    const entry = binding === undefined ? undefined : this.deps.store.get(binding.connectionId);
    if (uri === undefined || binding === undefined || entry === undefined) {
      this.item.hide();
      return;
    }
    this.item.text = textOf(this.deps.runs.of(uri) !== undefined, entry.name, binding.catalog);
    this.item.tooltip = `${this.deps.icons.label(entry.type)} connection "${entry.name}". Click to change.`;
    this.item.show();
  }

  dispose(): void {
    for (const listener of this.listeners) listener.dispose();
    this.item.dispose();
  }
}

/** `$(database) <name>`, the spinner in place of the icon while running, and ` (<catalog>)` when there is one. */
function textOf(running: boolean, name: string, catalog: string | undefined): string {
  const icon = running ? "$(loading~spin)" : "$(database)";
  return catalog === undefined ? `${icon} ${name}` : `${icon} ${name} (${catalog})`;
}
