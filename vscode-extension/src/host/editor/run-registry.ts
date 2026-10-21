// The runs in flight, one per editor document (part 3, "The run" and "Cancel"; part 1, "Cancellation").
import * as vscode from "vscode";
import { renamedKey } from "./bindings";

/** From the moment Run has its editor and binding until a queryId is minted: the open, the catalog step and query/target. */
export interface PreparingRun {
  readonly phase: "preparing";
  readonly uri: string;
  readonly connectionId: string;
  readonly tokenSource: vscode.CancellationTokenSource;
}

/** Part 3's entry: { queryId, uri, connectionId, catalog, statement, limit, tokenSource, cancellable }. */
export interface RunEntry {
  readonly phase: "running";
  readonly queryId: string;
  readonly uri: string;
  readonly connectionId: string;
  readonly catalog?: string;
  readonly statement: string;
  readonly limit: number;
  readonly tokenSource: vscode.CancellationTokenSource;
  /** description.capabilities.supportsQueryCancel of the connection the run was sent on. */
  readonly cancellable: boolean;
}

export type RegisteredRun = PreparingRun | RunEntry;

export const ALREADY_RUNNING = "A query is already running in this editor.";

/** A second Run in an editor whose run has not settled. */
export class RunInFlightError extends Error {
  constructor() {
    super(ALREADY_RUNNING);
    this.name = "RunInFlightError";
  }
}

/**
 * Every run of this window by its document's key, `uri.toString()`.
 * A run keeps its token source from prepare to settle, through any move, so the token source is its identity.
 */
export class RunRegistry implements vscode.Disposable {
  private readonly runs = new Map<string, RegisteredRun>();
  private readonly changes = new vscode.EventEmitter<void>();

  /** Fires once per call that changed the registry, never for a call that changed nothing. */
  readonly onDidChange: vscode.Event<void> = this.changes.event;

  constructor(private readonly newTokenSource: () => vscode.CancellationTokenSource) {}

  /** Throws RunInFlightError when the uri already holds a run. */
  prepare(uri: string, connectionId: string): PreparingRun {
    if (this.runs.has(uri)) throw new RunInFlightError();
    const prepared: PreparingRun = { phase: "preparing", uri, connectionId, tokenSource: this.newTokenSource() };
    this.runs.set(uri, prepared);
    this.changes.fire();
    return prepared;
  }

  /** Replaces the preparing run, if it is still the uri's, with its running entry; throws when it is not. */
  start(
    prepared: PreparingRun,
    run: Pick<RunEntry, "queryId" | "catalog" | "statement" | "limit" | "cancellable">,
  ): RunEntry {
    const uri = keyOf(this.runs, prepared);
    if (uri === undefined) throw new Error(`The run of ${prepared.uri} is no longer registered.`);
    const entry: RunEntry = {
      phase: "running",
      queryId: run.queryId,
      uri,
      connectionId: prepared.connectionId,
      catalog: run.catalog,
      statement: run.statement,
      limit: run.limit,
      tokenSource: prepared.tokenSource,
      cancellable: run.cancellable,
    };
    this.runs.set(uri, entry);
    this.changes.fire();
    return entry;
  }

  /** Removes the run if it is still its uri's, and disposes its token source. */
  settle(run: RegisteredRun): void {
    const uri = keyOf(this.runs, run);
    if (uri === undefined) return;
    this.runs.delete(uri);
    run.tokenSource.dispose();
    this.changes.fire();
  }

  of(uri: string): RegisteredRun | undefined {
    return this.runs.get(uri);
  }

  byQueryId(queryId: string): RunEntry | undefined {
    for (const run of this.runs.values()) {
      if (run.phase === "running" && run.queryId === queryId) return run;
    }
    return undefined;
  }

  /** libredb.runningQueries: every uri holding a run. */
  running(): readonly string[] {
    return [...this.runs.keys()];
  }

  /** libredb.cancellableQueries: every preparing uri, and every running uri whose entry is cancellable. */
  cancellable(): readonly string[] {
    return [...this.runs].filter(([, run]) => run.phase === "preparing" || run.cancellable).map(([uri]) => uri);
  }

  /** Cancels the token of the uri's run, if any (the editor closed, its connection removed). */
  cancelUri(uri: string): void {
    this.runs.get(uri)?.tokenSource.cancel();
  }

  /**
   * Cancels the token of every run on the connection, preparing or running, and leaves each registered until it
   * settles (the connection's profile was edited, so a run prepared against the old profile must not reach the new one).
   */
  cancelConnection(connectionId: string): void {
    for (const run of this.runs.values()) {
      if (run.connectionId === connectionId) run.tokenSource.cancel();
    }
  }

  /** The key the run is registered under now, after any move or rename, or undefined once it is no longer registered. */
  uriOf(run: RegisteredRun): string | undefined {
    return keyOf(this.runs, run);
  }

  /** Save As: the run at `from` keeps its token and queryId under `to`. */
  move(from: string, to: string): void {
    const run = this.runs.get(from);
    if (run === undefined) return;
    this.runs.delete(from);
    this.runs.set(to, { ...run, uri: to });
    this.changes.fire();
  }

  /** A file or folder rename: every run renamedKey maps keeps its token and queryId under the new key. */
  rename(oldUri: string, newUri: string): void {
    const moves: [string, RegisteredRun][] = [];
    for (const [uri, run] of this.runs) {
      const to = renamedKey(uri, oldUri, newUri);
      if (to !== undefined) moves.push([uri, { ...run, uri: to }]);
    }
    if (moves.length === 0) return;
    for (const [from] of moves) this.runs.delete(from);
    for (const [, run] of moves) this.runs.set(run.uri, run);
    this.changes.fire();
  }

  /** A backend crash: forgets every run (part 1: the supervisor's crash clears both keys); their requests reject on their own. */
  clear(): void {
    if (this.runs.size === 0) return;
    this.runs.clear();
    this.changes.fire();
  }

  dispose(): void {
    this.changes.dispose();
  }
}

/** The key the run is registered under now, found by its token source, or undefined when it is no longer registered. */
function keyOf(runs: ReadonlyMap<string, RegisteredRun>, run: RegisteredRun): string | undefined {
  for (const [uri, registered] of runs) {
    if (registered.tokenSource === run.tokenSource) return uri;
  }
  return undefined;
}
