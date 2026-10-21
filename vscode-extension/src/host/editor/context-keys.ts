// The three context keys a menu's when clause reads (part 3, "Binding a document to a connection").
import type * as vscode from "vscode";
import { CONTEXT_KEYS } from "../names";
import type { BindingStore } from "./bindings";
import type { RunRegistry } from "./run-registry";

export interface ContextKeyDeps {
  readonly bindings: Pick<BindingStore, "keys" | "onDidChange">;
  readonly runs: Pick<RunRegistry, "running" | "cancellable" | "onDidChange">;
  /** commands.executeCommand("setContext", key, value) */
  setContext(key: string, value: readonly string[]): Thenable<unknown>;
  readonly log: Pick<vscode.LogOutputChannel, "warn">;
}

/** Publishes all three keys once at construction and once per microtask after any change of either store. */
export class ContextKeys implements vscode.Disposable {
  private readonly listeners: vscode.Disposable[];
  private scheduled = false;
  private disposed = false;

  constructor(private readonly deps: ContextKeyDeps) {
    this.listeners = [deps.bindings.onDidChange(() => this.schedule()), deps.runs.onDidChange(() => this.schedule())];
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    for (const listener of this.listeners) listener.dispose();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.disposed) this.publish();
    });
  }

  private publish(): void {
    const { bindings, runs } = this.deps;
    this.set(CONTEXT_KEYS.boundDocuments, bindings.keys());
    this.set(CONTEXT_KEYS.runningQueries, runs.running());
    this.set(CONTEXT_KEYS.cancellableQueries, runs.cancellable());
  }

  private set(key: string, value: readonly string[]): void {
    this.deps.setContext(key, value).then(undefined, (error: unknown) => {
      this.deps.log.warn(`Publishing ${key} failed: ${messageOf(error)}`);
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
