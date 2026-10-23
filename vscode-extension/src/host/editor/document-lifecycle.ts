// What a save, a rename and a close do to a document's binding, run and results (part 3, "Save, rename and close";
// part 4, "Which result the view shows").
import type * as vscode from "vscode";
import type { ResultsPresenter } from "../results/results-presenter";
import type { BindingStore } from "./bindings";
import type { RunRegistry } from "./run-registry";

/** How long a closed untitled document, or a Save As candidate, waits for its close or reopen. */
export const CLOSE_GRACE_MS = 1000;

export interface LifecycleDeps {
  readonly workspace: Pick<
    typeof vscode.workspace,
    "onWillSaveTextDocument" | "onDidCloseTextDocument" | "onDidOpenTextDocument" | "onDidRenameFiles"
  >;
  readonly window: Pick<typeof vscode.window, "activeTextEditor">;
  readonly bindings: BindingStore;
  readonly runs: Pick<RunRegistry, "of" | "cancelUri" | "move" | "rename">;
  readonly presenter: Pick<ResultsPresenter, "documentClosed" | "documentMoved">;
  readonly timers: { setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
}

/** A save that may be a Save As of the untitled document: it moves only if that document closes within the grace. */
interface SaveCandidate {
  readonly fileUri: string;
  readonly timer: unknown;
}

/**
 * Save As moves a bound untitled document's binding, run and results to the file it was saved as; a rename moves those
 * of every document under the old uri; a closed untitled document loses them after CLOSE_GRACE_MS unless it reopens
 * with the same text (a language switch closes and reopens it), and at once when another document takes its uri; a
 * closed file keeps its binding, and its run and results end at the close.
 */
export class DocumentLifecycle implements vscode.Disposable {
  /** By the untitled document's key. */
  private readonly candidates = new Map<string, SaveCandidate>();
  /** The grace timer of each closed untitled document and the text it closed with, by its key. */
  private readonly closing = new Map<string, { readonly timer: unknown; readonly text: string }>();
  private readonly listeners: vscode.Disposable[];

  constructor(private readonly deps: LifecycleDeps) {
    const { workspace } = deps;
    this.listeners = [
      workspace.onWillSaveTextDocument((event) => this.willSave(event.document)),
      workspace.onDidCloseTextDocument((document) => this.closed(document)),
      workspace.onDidOpenTextDocument((document) => this.opened(document)),
      workspace.onDidRenameFiles((event) => {
        for (const { oldUri, newUri } of event.files) this.renamed(oldUri.toString(), newUri.toString());
      }),
    ];
  }

  dispose(): void {
    for (const listener of this.listeners) listener.dispose();
    for (const { timer } of this.candidates.values()) this.deps.timers.clearTimeout(timer);
    for (const { timer } of this.closing.values()) this.deps.timers.clearTimeout(timer);
    this.candidates.clear();
    this.closing.clear();
  }

  /**
   * Synchronous: records the candidate when the saved document is unbound and the active editor shows a bound untitled
   * document with the same language and text, which is what Save As of that document looks like.
   */
  private willSave(saved: vscode.TextDocument): void {
    const { bindings, timers } = this.deps;
    const fileUri = saved.uri.toString();
    if (bindings.get(fileUri) !== undefined) return;
    const active = this.deps.window.activeTextEditor?.document;
    if (active === undefined || !active.isUntitled) return;
    const untitledUri = active.uri.toString();
    if (bindings.get(untitledUri) === undefined) return;
    if (active.languageId !== saved.languageId || active.getText() !== saved.getText()) return;
    this.dropCandidate(untitledUri);
    const timer = timers.setTimeout(() => this.candidates.delete(untitledUri), CLOSE_GRACE_MS);
    this.candidates.set(untitledUri, { fileUri, timer });
  }

  private closed(document: vscode.TextDocument): void {
    const uri = document.uri.toString();
    const candidate = this.candidates.get(uri);
    if (candidate !== undefined) {
      this.dropCandidate(uri);
      this.deps.bindings.move(uri, candidate.fileUri);
      this.deps.runs.move(uri, candidate.fileUri);
      this.deps.presenter.documentMoved(uri, candidate.fileUri);
      return;
    }
    if (!document.isUntitled) {
      this.deps.runs.cancelUri(uri);
      this.deps.presenter.documentClosed(uri);
      return;
    }
    this.stopGrace(uri);
    const timer = this.deps.timers.setTimeout(() => {
      this.closing.delete(uri);
      this.release(uri);
    }, CLOSE_GRACE_MS);
    this.closing.set(uri, { timer, text: document.getText() });
  }

  /**
   * A reopen with the closed text is a language switch, which keeps the binding and run; any other document at that uri
   * is a new untitled document that reused the freed name, so the closed one's binding, run and results end now.
   */
  private opened(document: vscode.TextDocument): void {
    const uri = document.uri.toString();
    const closing = this.stopGrace(uri);
    if (closing !== undefined && closing.text !== document.getText()) this.release(uri);
  }

  /** A closed untitled document's end: its binding, its run and its results. */
  private release(uri: string): void {
    this.deps.bindings.unbind(uri);
    this.deps.runs.cancelUri(uri);
    this.deps.presenter.documentClosed(uri);
  }

  private renamed(oldUri: string, newUri: string): void {
    const moved = this.deps.bindings.rename(oldUri, newUri);
    this.deps.runs.rename(oldUri, newUri);
    for (const [from, to] of moved) this.deps.presenter.documentMoved(from, to);
  }

  private dropCandidate(untitledUri: string): void {
    const candidate = take(this.candidates, untitledUri);
    if (candidate !== undefined) this.deps.timers.clearTimeout(candidate.timer);
  }

  /** Stops the uri's grace, if one is running, and answers what it held. */
  private stopGrace(uri: string): { readonly timer: unknown; readonly text: string } | undefined {
    const closing = take(this.closing, uri);
    if (closing !== undefined) this.deps.timers.clearTimeout(closing.timer);
    return closing;
  }
}

/** Removes the key's value from the map and answers it, or undefined when the map held none. */
function take<T>(map: Map<string, T>, key: string): T | undefined {
  const value = map.get(key);
  map.delete(key);
  return value;
}
