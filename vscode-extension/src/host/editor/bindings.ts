// Which connection each query editor document runs on (part 3, "Binding a document to a connection").
import * as vscode from "vscode";
import type { EditorRelease } from "../connections/remove-connection";
import type { RunRegistry } from "./run-registry";

/** The connection a document runs on, and the catalog its runs use where the description declares catalog sessions. */
export interface EditorBinding {
  readonly connectionId: string;
  readonly catalog?: string;
}

/**
 * The bindings of this window, keyed by `document.uri.toString()` and kept in memory only, so a window reload forgets
 * them and the first Run asks for the connection again.
 */
export class BindingStore implements vscode.Disposable {
  private readonly bindings = new Map<string, EditorBinding>();
  private readonly changes = new vscode.EventEmitter<void>();

  /** Fires once per call that changed the map, never for a call that changed nothing. */
  readonly onDidChange: vscode.Event<void> = this.changes.event;

  get(uri: string): EditorBinding | undefined {
    return this.bindings.get(uri);
  }

  bind(uri: string, binding: EditorBinding): void {
    const current = this.bindings.get(uri);
    if (current?.connectionId === binding.connectionId && current.catalog === binding.catalog) return;
    this.bindings.set(uri, binding);
    this.changes.fire();
  }

  unbind(uri: string): void {
    if (this.bindings.delete(uri)) this.changes.fire();
  }

  /** Save As: the binding at `from` moves to `to`; nothing when `from` holds none. */
  move(from: string, to: string): void {
    const binding = this.bindings.get(from);
    if (binding === undefined) return;
    this.bindings.delete(from);
    this.bindings.set(to, binding);
    this.changes.fire();
  }

  /** A file or folder rename: every key renamedKey maps moves; answers the [from, to] pairs it moved. */
  rename(oldUri: string, newUri: string): ReadonlyArray<readonly [string, string]> {
    const moves: [string, string, EditorBinding][] = [];
    for (const [key, binding] of this.bindings) {
      const to = renamedKey(key, oldUri, newUri);
      if (to !== undefined) moves.push([key, to, binding]);
    }
    if (moves.length === 0) return [];
    for (const [from] of moves) this.bindings.delete(from);
    for (const [, to, binding] of moves) this.bindings.set(to, binding);
    this.changes.fire();
    return moves.map(([from, to]) => [from, to] as const);
  }

  /** Removes every binding of the connection and answers the keys it removed. */
  unbindConnection(connectionId: string): string[] {
    const removed = [...this.bindings]
      .filter(([, binding]) => binding.connectionId === connectionId)
      .map(([key]) => key);
    if (removed.length === 0) return [];
    for (const key of removed) this.bindings.delete(key);
    this.changes.fire();
    return removed;
  }

  /** Every bound key, in binding order. */
  keys(): readonly string[] {
    return [...this.bindings.keys()];
  }

  dispose(): void {
    this.changes.dispose();
  }
}

/**
 * Remove's step 4 over these bindings: unbinds every editor of the connection and cancels each one's run; and an edit's
 * release, which cancels every run on the connection and keeps the bindings.
 */
export function editorRelease(
  bindings: BindingStore,
  runs: Pick<RunRegistry, "cancelUri" | "cancelConnection">,
): EditorRelease {
  return {
    releaseConnection(connectionId) {
      for (const uri of bindings.unbindConnection(connectionId)) runs.cancelUri(uri);
    },
    cancelRuns(connectionId) {
      runs.cancelConnection(connectionId);
    },
  };
}

/** The key a rename gives `key`: newUri plus the same suffix when key equals oldUri or starts with oldUri + "/", else undefined. */
export function renamedKey(key: string, oldUri: string, newUri: string): string | undefined {
  if (key === oldUri) return newUri;
  if (key.startsWith(`${oldUri}/`)) return newUri + key.slice(oldUri.length);
  return undefined;
}
