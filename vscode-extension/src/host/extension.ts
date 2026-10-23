import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { BindingStore, editorRelease } from "./editor/bindings";
import { cancelQuery, changeConnection, type EditorCommandDeps, newQuery, selectRows } from "./editor/commands";
import { ContextKeys } from "./editor/context-keys";
import { DocumentLifecycle } from "./editor/document-lifecycle";
import { runQuery } from "./editor/run-query";
import { RunRegistry } from "./editor/run-registry";
import { RunService } from "./editor/run-service";
import { ConnectionStatusBar } from "./editor/status-bar";
import { COMMANDS, CONNECTIONS_VIEW, RESULTS_VIEW } from "./names";
import { OpenConnections } from "./open-connections";
import { newNonce } from "./results/html";
import { LogResultsPresenter } from "./results/log-presenter";
import { fanOut, ResultsViewPresenter } from "./results/results-presenter";
import { ResultsViewProvider } from "./results/results-view-provider";
import { ConnectionsTree } from "./tree/connections-tree";
import { EngineIcons, readEngineIndex } from "./tree/icons";
import { refreshTarget } from "./tree/nodes";

/** The backend child's supervisor, from activate until deactivate; it starts nothing until the first backend call. */
let supervisor: BackendSupervisor | undefined;

/**
 * Reads the engine index the build wrote, creates the LibreDB log channel, registers the command that shows it, creates
 * the backend supervisor, reads the libredb.connections setting into the connection store, creates the Connections view
 * on its tree, registers Add Connection, Remove Connection and Refresh, the editor commands, and the Results view, whose
 * presenter the run service presents to beside the log.
 * Reading the setting needs no backend, the tree's root reads the store only and resolving the Results view renders
 * without one, so activation starts no child (part 2 criterion 1, part 4 criterion 2). A missing or unreadable index is
 * a broken install and throws before anything is registered.
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
  const icons = new EngineIcons(context.extensionUri, index);
  const tree = new ConnectionsTree({
    store,
    client,
    opened,
    link: supervisor,
    icons,
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
  const bindings = new BindingStore();
  const runs = new RunRegistry(() => new vscode.CancellationTokenSource());
  const editors = editorRelease(bindings, runs);
  const keys = new ContextKeys({
    bindings,
    runs,
    setContext: (key, value) => vscode.commands.executeCommand("setContext", key, value),
    log,
  });
  // The view reaches its presenter, and the presenter the run service, through closures that run only after activate
  // has returned, so each is a const declared after the one that names it.
  const provider = new ResultsViewProvider({
    extensionUri: context.extensionUri,
    window: vscode.window,
    commands: vscode.commands,
    clipboard: vscode.env.clipboard,
    log,
    session: { replay: () => results.replay(), loadMore: (runId) => results.loadMore(runId) },
    newNonce,
  });
  const results = new ResultsViewPresenter({
    surface: provider,
    pages: { runPage: (read) => service.runPage(read) },
    log,
    newRunId: randomUUID,
    now: Date.now,
  });
  // The log keeps one metadata line per run beside the view: the only run history a window reload leaves.
  const presenter = fanOut(results, new LogResultsPresenter(log));
  const service = new RunService({ client, runs, presenter, opened, window: vscode.window, newQueryId: randomUUID });
  const statusBar = new ConnectionStatusBar({ window: vscode.window, bindings, runs, store, icons });
  const lifecycle = new DocumentLifecycle({
    workspace: vscode.workspace,
    window: vscode.window,
    bindings,
    runs,
    presenter,
    timers: { setTimeout, clearTimeout },
  });
  const editing: EditorCommandDeps = {
    store,
    icons,
    window: vscode.window,
    workspace: vscode.workspace,
    languages: vscode.languages,
    client,
    bindings,
    runs,
    service,
    log,
    timers: { setTimeout },
    showLog,
    openUserSettings,
    addConnection: () => vscode.commands.executeCommand(COMMANDS.addConnection),
  };
  const removing: RemoveDeps = { store, client, editors, window: vscode.window, log, openUserSettings };
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
    bindings,
    runs,
    // A crash forgets every run, so both run keys empty; each run's request rejects on its own.
    supervisor.onDidCrash(() => runs.clear()),
    keys,
    statusBar,
    lifecycle,
    vscode.commands.registerCommand(COMMANDS.newQuery, (target?: unknown) => newQuery(editing, target)),
    vscode.commands.registerCommand(COMMANDS.selectRows, (target: unknown) => selectRows(editing, target)),
    vscode.commands.registerCommand(COMMANDS.runQuery, (target?: unknown) => runQuery(editing, target)),
    vscode.commands.registerCommand(COMMANDS.cancelQuery, (target?: unknown) => cancelQuery(editing, target)),
    vscode.commands.registerCommand(COMMANDS.changeConnection, (target?: unknown) => changeConnection(editing, target)),
    releaseOnChange(store, client, log, editors),
    provider,
    vscode.window.onDidChangeActiveTextEditor((editor) =>
      results.activeDocumentChanged(editor?.document.uri.toString()),
    ),
    vscode.window.registerWebviewViewProvider(RESULTS_VIEW, provider),
  );
}

/** The supervisor's stop(), which VS Code awaits as an asynchronous cleanup (activation-events.md). */
export function deactivate(): Promise<void> | undefined {
  const stopping = supervisor?.stop();
  supervisor = undefined;
  return stopping;
}
