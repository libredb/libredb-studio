// The e2e leg's seam to the Connections tree: activate exports nothing by design, so a test reaches the tree through
// the vscode API object the extension host hands both the extension and the test files inside its folder, by wrapping
// window.createTreeView before the extension activates. Each test file is bundled on its own, so the capture lives on
// that shared object and on globalThis, never in this module's own state.
import * as vscode from "vscode";
import { CONNECTIONS_VIEW } from "../../src/host/names";

export interface TreeCapture {
  readonly provider: vscode.TreeDataProvider<unknown>;
  readonly view: vscode.TreeView<unknown>;
}

const MARK = Symbol.for("libredb.e2e.treeCapture");

type CreateTreeView = typeof vscode.window.createTreeView;

/** The views created since the first install, by view id, kept on globalThis so every bundle reads the same map. */
function captures(): Map<string, TreeCapture> {
  const holder = globalThis as { [MARK]?: Map<string, TreeCapture> };
  holder[MARK] ??= new Map();
  return holder[MARK];
}

/** Wraps vscode.window.createTreeView once per host at import; idempotent across the bundles that import it. */
export function installTreeCapture(): void {
  const window = vscode.window as { createTreeView: CreateTreeView };
  if ((window.createTreeView as { [MARK]?: true })[MARK] === true) return;
  const original = window.createTreeView.bind(vscode.window);
  const wrapped = (<T>(viewId: string, options: vscode.TreeViewOptions<T>): vscode.TreeView<T> => {
    const view = original(viewId, options);
    captures().set(viewId, {
      provider: options.treeDataProvider as vscode.TreeDataProvider<unknown>,
      view: view as vscode.TreeView<unknown>,
    });
    return view;
  }) as CreateTreeView;
  Object.defineProperty(wrapped, MARK, { value: true });
  window.createTreeView = wrapped;
  if (window.createTreeView !== wrapped) throw new Error("vscode.window.createTreeView could not be replaced.");
}

/** The capture for "libredb.connections"; throws "The Connections view was not created; was the extension active before the capture?" when none. */
export function connectionsTree(): TreeCapture {
  const capture = captures().get(CONNECTIONS_VIEW);
  if (capture === undefined) {
    throw new Error("The Connections view was not created; was the extension active before the capture?");
  }
  return capture;
}
