// The last ProviderDescription each connection's open answered (part 3, "Lazy loading, caching and refresh"): the tree,
// and later the editors, read a connection's capabilities and labels here, so the host holds no engine fact of its own.
import * as vscode from "vscode";
import type { ProviderDescription } from "../protocol";
import type { BackendLink } from "./backend-supervisor";

/** What the last connection/open of an id answered, and the child generation it was answered in. */
export interface OpenedConnection {
  readonly description: ProviderDescription;
  readonly generation: number;
}

/** Filled by BackendClient on every open, its own reopens included, and emptied when it closes or forgets an id. */
export class OpenConnections implements vscode.Disposable {
  private readonly records = new Map<string, OpenedConnection>();
  private readonly changes = new vscode.EventEmitter<string>();
  /** Fires the id whose record was replaced or forgotten. */
  readonly onDidChange: vscode.Event<string> = this.changes.event;

  /** Replaces the id's record, then fires the id. */
  record(connectionId: string, generation: number, description: ProviderDescription): void {
    this.records.set(connectionId, { description, generation });
    this.changes.fire(connectionId);
  }

  /** Forgets the id's record, and fires the id only when it held one. */
  forget(connectionId: string): void {
    if (this.records.delete(connectionId)) this.changes.fire(connectionId);
  }

  get(connectionId: string): OpenedConnection | undefined {
    return this.records.get(connectionId);
  }

  dispose(): void {
    this.changes.dispose();
  }
}

/**
 * Whether a connection is connected: derived, never stored, so a crash or a new generation needs no update. It is when
 * its last open was answered in the link's current generation and the link is ready.
 */
export function isConnected(
  opened: OpenedConnection | undefined,
  link: Pick<BackendLink, "generation" | "state">,
): boolean {
  return opened?.generation === link.generation && link.state === "ready";
}
