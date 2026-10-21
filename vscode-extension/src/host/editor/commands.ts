// The editor commands besides Run (part 3, "New Query", "Select Rows", "Cancel" and "Change Connection").
import * as vscode from "vscode";
import { catalogOfPath, declaresCatalogSessions } from "@/lib/db/object-kinds";
import type { DatabaseObject } from "@/lib/db/types";
import type { ProviderDescription } from "../../protocol";
import type { BackendClient } from "../backend-client";
import { UnknownConnectionError } from "../connections/connection-store";
import type { ProfileEntry } from "../connections/profile";
import { CONNECTIONS_VIEW } from "../names";
import { isIssuedNode } from "../tree/nodes";
import type { EditorBinding } from "./bindings";
import { reportCommandFailure } from "./command-failure";
import { pickCatalog, pickConnection, UNBIND } from "./connection-picker";
import { vscodeLanguageOf } from "./editor-language";
import {
  documentLabel,
  editorOf,
  type RowLimitError,
  type RunQueryDeps,
  readRowLimit,
  showRowLimitError,
} from "./run-query";
import type { RunService } from "./run-service";

export interface EditorCommandDeps extends RunQueryDeps {
  readonly window: RunQueryDeps["window"] &
    Pick<typeof vscode.window, "showTextDocument" | "withProgress" | "showWarningMessage">;
  readonly workspace: RunQueryDeps["workspace"] & Pick<typeof vscode.workspace, "openTextDocument">;
  readonly languages: Pick<typeof vscode.languages, "setTextDocumentLanguage">;
  readonly client: RunQueryDeps["client"] & Pick<BackendClient, "selectStatement">;
  readonly service: Pick<RunService, "execute" | "cancel">;
}

export const SERVER_DID_NOT_STOP = "The server did not stop the statement.";
export const CHANGE_REFUSED =
  "A query is running in this editor. Cancel it or let it finish before changing its connection.";

const NOT_A_QUERY_NODE = "libredb.newQuery takes a connection, container, folder or object node, or nothing.";
const NOT_A_RELATION = "libredb.selectRows takes a table or view node.";

/** The node New Query or Select Rows was given, with the path whose catalog binds it; throws for anything else. */
export function queryNodeOf(
  target: unknown,
): { readonly connectionId: string; readonly path: readonly string[] } | undefined {
  if (target === undefined) return undefined;
  if (!isIssuedNode(target)) throw new Error(NOT_A_QUERY_NODE);
  // The node union's own fields, never a type id.
  const node = target as { readonly node?: unknown; readonly connectionId: string };
  switch (node.node) {
    case "connection":
      return { connectionId: node.connectionId, path: [] };
    case "container":
      return { connectionId: node.connectionId, path: (target as { container: { path: string[] } }).container.path };
    case "folder":
      return { connectionId: node.connectionId, path: (target as { containerPath: string[] }).containerPath };
    case "object":
      return { connectionId: node.connectionId, path: (target as { object: DatabaseObject }).object.path };
    default:
      throw new Error(NOT_A_QUERY_NODE);
  }
}

/** libredb.newQuery: from a connection, container, folder or object node, or from the palette (undefined). */
export async function newQuery(deps: EditorCommandDeps, target?: unknown): Promise<void> {
  const node = queryNodeOf(target);
  let connectionId: string;
  if (node === undefined) {
    const picked = await pickConnection(deps, { placeHolder: "Choose a connection for the new query" });
    if (picked === undefined) return;
    connectionId = picked;
  } else {
    connectionId = node.connectionId;
  }
  let description: ProviderDescription;
  let catalog: string | undefined;
  try {
    const progress =
      node === undefined ? windowProgress(deps, connectionId) : { location: { viewId: CONNECTIONS_VIEW } };
    description = await deps.window.withProgress(progress, () => deps.client.ensureOpen(connectionId));
    catalog = catalogOfPath(description.capabilities, node?.path ?? []);
    if (catalog === undefined && declaresCatalogSessions(description.capabilities)) {
      catalog = await pickCatalog(deps, connectionId, description);
      if (catalog === undefined) return;
    }
  } catch (error) {
    reportCommandFailure(deps, error);
    return;
  }
  await openBound(deps, description, "", bindingOf(connectionId, catalog));
}

/** libredb.selectRows: an object node whose role is relation; resolves once its run settled. */
export async function selectRows(deps: EditorCommandDeps, target: unknown): Promise<void> {
  const node = target as { readonly node?: unknown; readonly role?: unknown } | undefined;
  if (!isIssuedNode(node) || node?.node !== "object" || node.role !== "relation") {
    throw new Error(NOT_A_RELATION);
  }
  const { connectionId, object } = target as { readonly connectionId: string; readonly object: DatabaseObject };
  let entry: ProfileEntry;
  let description: ProviderDescription;
  let statement: string;
  try {
    const found = deps.store.get(connectionId);
    if (found === undefined) throw new UnknownConnectionError(connectionId);
    entry = found;
    description = await deps.window.withProgress({ location: { viewId: CONNECTIONS_VIEW } }, () =>
      deps.client.ensureOpen(connectionId),
    );
    ({ statement } = await deps.client.selectStatement({ connectionId, object }));
  } catch (error) {
    reportCommandFailure(deps, error);
    return;
  }
  const binding = bindingOf(connectionId, catalogOfPath(description.capabilities, object.path));
  const document = await openBound(deps, description, statement, binding);
  let limit: number;
  try {
    limit = readRowLimit(deps.workspace);
  } catch (error) {
    showRowLimitError(deps, error as RowLimitError);
    return;
  }
  // The whole text runs, never through query/target: a click runs exactly the text it generated (part 3 step 4).
  const prepared = deps.runs.prepare(document.uri.toString(), connectionId);
  try {
    await deps.service.execute(prepared, {
      documentLabel: documentLabel(document),
      connectionName: entry.name,
      connectionType: entry.type,
      description,
      statement,
      ...(binding.catalog === undefined ? {} : { catalog: binding.catalog }),
      limit,
    });
  } catch (error) {
    reportCommandFailure(deps, error);
  }
}

/** libredb.cancelQuery: the editor title's uri, or the active editor's document. */
export async function cancelQuery(deps: EditorCommandDeps, target?: unknown): Promise<void> {
  const editor = editorOf(deps.window, target, "libredb.cancelQuery");
  if (editor === undefined) return;
  try {
    const result = await deps.service.cancel(editor.document.uri.toString());
    // A stopped run, or one with nothing sent, settles through its own request.
    if (result?.cancelled === false) void deps.window.showWarningMessage(SERVER_DID_NOT_STOP);
  } catch (error) {
    reportCommandFailure(deps, error);
  }
}

/** libredb.changeConnection: the editor title's uri, or the active editor's document. */
export async function changeConnection(deps: EditorCommandDeps, target?: unknown): Promise<void> {
  const editor = editorOf(deps.window, target, "libredb.changeConnection");
  if (editor === undefined) return;
  const { document } = editor;
  const uri = document.uri.toString();
  if (refusedWhileRunning(deps, uri)) return;
  const current = deps.bindings.get(uri);
  const picked = await pickConnection(deps, {
    placeHolder: "Choose the connection for this editor",
    current: current?.connectionId,
    offerUnbind: current !== undefined,
  });
  if (picked === undefined) return;
  if (picked === UNBIND) {
    deps.bindings.unbind(uri);
    return;
  }
  let description: ProviderDescription;
  let catalog: string | undefined;
  try {
    description = await deps.window.withProgress(windowProgress(deps, picked), () => deps.client.ensureOpen(picked));
    if (declaresCatalogSessions(description.capabilities)) {
      catalog = await pickCatalog(deps, picked, description);
      if (catalog === undefined) return;
    }
  } catch (error) {
    reportCommandFailure(deps, error);
    return;
  }
  // A Run may have started while the person chose.
  if (refusedWhileRunning(deps, uri)) return;
  // Rebound first, so the close and open setTextDocumentLanguage fires find the new binding.
  deps.bindings.bind(uri, bindingOf(picked, catalog));
  const language = vscodeLanguageOf(description.editorLanguage);
  // A file keeps its language: that is the person's choice.
  if (document.isUntitled && document.languageId !== language) {
    await deps.languages.setTextDocumentLanguage(document, language);
  }
}

/** Shows CHANGE_REFUSED and answers true when the document holds a run, preparing or running. */
function refusedWhileRunning(deps: EditorCommandDeps, uri: string): boolean {
  if (deps.runs.of(uri) === undefined) return false;
  void deps.window.showWarningMessage(CHANGE_REFUSED);
  return true;
}

/** The progress of an open from the palette or Change Connection; throws UnknownConnectionError off the valid ids. */
function windowProgress(deps: EditorCommandDeps, connectionId: string): vscode.ProgressOptions {
  const entry = deps.store.get(connectionId);
  if (entry === undefined) throw new UnknownConnectionError(connectionId);
  return { location: vscode.ProgressLocation.Window, title: `LibreDB: opening ${entry.name}` };
}

/** Opens an untitled document in the description's editor language, shows it outside preview and binds it. */
async function openBound(
  deps: EditorCommandDeps,
  description: ProviderDescription,
  content: string,
  binding: EditorBinding,
): Promise<vscode.TextDocument> {
  const document = await deps.workspace.openTextDocument({
    language: vscodeLanguageOf(description.editorLanguage),
    content,
  });
  await deps.window.showTextDocument(document, { preview: false });
  deps.bindings.bind(document.uri.toString(), binding);
  return document;
}

/** The binding, with no catalog key when it has none. */
function bindingOf(connectionId: string, catalog: string | undefined): EditorBinding {
  return catalog === undefined ? { connectionId } : { connectionId, catalog };
}
