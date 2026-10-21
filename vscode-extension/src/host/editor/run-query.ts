// Run (part 3, "What text Run sends" and "The run"): the editor, its binding, the open, the catalog, query/target,
// the highlight and the run, each step's exit leaving nothing registered.
import * as vscode from "vscode";
import { declaresCatalogSessions } from "@/lib/db/object-kinds";
import type { ProviderDescription } from "../../protocol";
import type { BackendClient } from "../backend-client";
import { OPEN_USER_SETTINGS } from "../connections/add-connection-ui";
import { type ConnectionStore, UnknownConnectionError } from "../connections/connection-store";
import type { BindingStore, EditorBinding } from "./bindings";
import { type FailureDeps, reportCommandFailure } from "./command-failure";
import { type PickerDeps, pickCatalog, pickConnection } from "./connection-picker";
import { ALREADY_RUNNING, type PreparingRun, type RunRegistry } from "./run-registry";
import type { RunRequest, RunService } from "./run-service";

export const NOTHING_TO_RUN = "Nothing to run.";
export const EDITOR_NOT_VISIBLE = "The editor to run is not visible.";
export const NO_ACTIVE_EDITOR = "Open an editor to run a query.";
export const HIGHLIGHT_MS = 1000;
export const ROW_LIMIT_MAX = 10_000;

/** "libredb.query.rowLimit must be a whole number from 1 to 10000; it is <JSON of the value>." */
export class RowLimitError extends Error {
  constructor(value: unknown) {
    super(`libredb.query.rowLimit must be a whole number from 1 to ${ROW_LIMIT_MAX}; it is ${JSON.stringify(value)}.`);
    this.name = "RowLimitError";
  }
}

/**
 * libredb.query.rowLimit, read at each run (VS Code answers the manifest's default when it is unset); throws
 * RowLimitError for a value that is not an integer in [1, ROW_LIMIT_MAX], undefined included, rather than clamping it.
 */
export function readRowLimit(workspace: Pick<typeof vscode.workspace, "getConfiguration">): number {
  const value: unknown = workspace.getConfiguration("libredb").get("query.rowLimit");
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > ROW_LIMIT_MAX) {
    throw new RowLimitError(value);
  }
  return value;
}

export interface RunQueryDeps extends PickerDeps, FailureDeps {
  readonly window: PickerDeps["window"] &
    FailureDeps["window"] &
    Pick<typeof vscode.window, "activeTextEditor" | "visibleTextEditors" | "createTextEditorDecorationType">;
  readonly workspace: Pick<typeof vscode.workspace, "getConfiguration">;
  readonly store: PickerDeps["store"] & Pick<ConnectionStore, "get">;
  readonly client: Pick<BackendClient, "ensureOpen" | "runTarget" | "listContainers">;
  readonly bindings: BindingStore;
  readonly runs: RunRegistry;
  readonly service: Pick<RunService, "execute">;
  readonly timers: { setTimeout(run: () => void, ms: number): unknown };
  /** executeCommand(OPEN_USER_SETTINGS' command) */
  openUserSettings(): Thenable<unknown>;
}

/**
 * The editor a command acts on: the visible editor showing the title's vscode.Uri, or the active editor with no
 * target; undefined, after an information message, when there is none. Throws for any other target, naming `command`.
 */
export function editorOf(
  window: Pick<typeof vscode.window, "activeTextEditor" | "visibleTextEditors" | "showInformationMessage">,
  target: unknown,
  command: string,
): vscode.TextEditor | undefined {
  if (target instanceof vscode.Uri) {
    const key = target.toString();
    const editor = window.visibleTextEditors.find(({ document }) => document.uri.toString() === key);
    if (editor === undefined) void window.showInformationMessage(EDITOR_NOT_VISIBLE);
    return editor;
  }
  if (target !== undefined) throw new Error(`${command} takes an editor's URI or nothing.`);
  const editor = window.activeTextEditor;
  if (editor === undefined) void window.showInformationMessage(NO_ACTIVE_EDITOR);
  return editor;
}

/** libredb.runQuery: target is the editor title's vscode.Uri, or undefined from the palette or a key; resolves once the run settled. */
export async function runQuery(deps: RunQueryDeps, target?: unknown): Promise<void> {
  const editor = editorOf(deps.window, target, "libredb.runQuery");
  if (editor === undefined) return;
  const { document } = editor;
  const uri = document.uri.toString();
  let binding = deps.bindings.get(uri);
  if (binding === undefined) {
    const connectionId = await pickConnection(deps, { placeHolder: "Choose a connection for this editor" });
    if (connectionId === undefined) return;
    binding = { connectionId };
    deps.bindings.bind(uri, binding);
  }
  if (deps.runs.of(uri) !== undefined) {
    void deps.window.showInformationMessage(ALREADY_RUNNING);
    return;
  }
  if (document.getText().trim() === "") {
    void deps.window.showInformationMessage(NOTHING_TO_RUN);
    return;
  }
  let limit: number;
  try {
    limit = readRowLimit(deps.workspace);
  } catch (error) {
    showRowLimitError(deps, error as RowLimitError);
    return;
  }
  const prepared = deps.runs.prepare(uri, binding.connectionId);
  let request: RunRequest | undefined;
  try {
    request = await prepare(deps, editor, prepared, binding, limit);
  } catch (error) {
    deps.runs.settle(prepared);
    reportCommandFailure(deps, error);
    return;
  }
  if (request === undefined) {
    deps.runs.settle(prepared);
    return;
  }
  try {
    await deps.service.execute(prepared, request);
  } catch (error) {
    reportCommandFailure(deps, error);
  }
}

/** The row limit's refusal, with Open User Settings: Run's step 5, which Select Rows shows the same way. */
export function showRowLimitError(deps: Pick<RunQueryDeps, "window" | "openUserSettings">, error: RowLimitError): void {
  void deps.window.showErrorMessage(error.message, OPEN_USER_SETTINGS).then((choice) => {
    if (choice === OPEN_USER_SETTINGS) void deps.openUserSettings();
  });
}

/**
 * Steps 7 to 11 under the prepared run's token: the open, the catalog, query/target and the highlight. Answers the
 * request, or undefined when the run was cancelled, the catalog pick dismissed, or the target holds no code.
 */
async function prepare(
  deps: RunQueryDeps,
  editor: vscode.TextEditor,
  prepared: PreparingRun,
  binding: EditorBinding,
  limit: number,
): Promise<RunRequest | undefined> {
  const { token } = prepared.tokenSource;
  const { document, selection } = editor;
  const { connectionId } = binding;
  // What Run sends is read together, before the first await, so an edit during the open cannot change it.
  const version = document.version;
  const text = document.getText();
  const offsets = { start: document.offsetAt(selection.start), end: document.offsetAt(selection.end) };
  const cursor = document.offsetAt(selection.active);
  const opened = await untilCancelled(deps.client.ensureOpen(connectionId), token);
  if (opened.cancelled) return undefined;
  const description: ProviderDescription = opened.value;
  let catalog = binding.catalog;
  if (declaresCatalogSessions(description.capabilities)) {
    if (catalog === undefined) {
      const picked = await untilCancelled(pickCatalog(deps, connectionId, description), token);
      if (picked.cancelled || picked.value === undefined) return undefined;
      catalog = picked.value;
      rebind(deps, prepared, { connectionId, catalog });
    }
  } else if (catalog !== undefined) {
    catalog = undefined;
    rebind(deps, prepared, { connectionId });
  }
  const target = await untilCancelled(
    deps.client.runTarget({
      connectionId,
      text,
      selection: offsets,
      cursor,
    }),
    token,
  );
  if (target.cancelled) return undefined;
  const { statement, range } = target.value;
  if (statement.trim() === "") {
    void deps.window.showInformationMessage(NOTHING_TO_RUN);
    return undefined;
  }
  // The range is an offset into the text read at Run; once the document changed it would mark text that did not run.
  if (range !== undefined && document.version === version) {
    const highlight = deps.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
    });
    editor.setDecorations(highlight, [
      new vscode.Range(document.positionAt(range.start), document.positionAt(range.end)),
    ]);
    deps.timers.setTimeout(() => highlight.dispose(), HIGHLIGHT_MS);
  }
  const entry = deps.store.get(connectionId);
  if (entry === undefined) throw new UnknownConnectionError(connectionId);
  return {
    documentLabel: documentLabel(document),
    connectionName: entry.name,
    connectionType: entry.type,
    description,
    statement,
    ...(catalog === undefined ? {} : { catalog }),
    limit,
  };
}

/**
 * Binds the document under the key its run is registered under now, so a rename or Save As during the open or the
 * catalog pick does not recreate a binding under the old key.
 */
function rebind(deps: Pick<RunQueryDeps, "bindings" | "runs">, prepared: PreparingRun, binding: EditorBinding): void {
  const uri = deps.runs.uriOf(prepared);
  if (uri !== undefined) deps.bindings.bind(uri, binding);
}

/** The label RunStart carries: the last segment of the uri's path (Untitled-1, q.sql). */
export function documentLabel(document: Pick<vscode.TextDocument, "uri">): string {
  return document.uri.path.split("/").at(-1) as string;
}

type Raced<T> = { readonly cancelled: true } | { readonly cancelled: false; readonly value: T };

/**
 * The promise's answer, or { cancelled: true } once the token is cancelled, leaving the late answer unread (part 1:
 * "the host side ignores a late answer"); a rejection before the cancel rejects.
 */
export function untilCancelled<T>(promise: Promise<T>, token: vscode.CancellationToken): Promise<Raced<T>> {
  return new Promise((resolve, reject) => {
    if (token.isCancellationRequested) resolve({ cancelled: true });
    const listener = token.onCancellationRequested(() => resolve({ cancelled: true }));
    promise.then(
      (value) => {
        listener.dispose();
        resolve({ cancelled: false, value });
      },
      (error: unknown) => {
        listener.dispose();
        reject(error);
      },
    );
  });
}
