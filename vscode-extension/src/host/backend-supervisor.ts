// The backend child's lifecycle on the host side (part 1, "Starting the child" and "Restart, shutdown, and what the
// person sees"): a lazy start shared by concurrent callers, the initialize handshake, the restart budget, and stop.
import type { ChildProcess, ForkOptions } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import * as vscode from "vscode";
import {
  createMessageConnection,
  IPCMessageReader,
  IPCMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { EXIT_NOTIFICATION, type InitializeResult, METHODS, PROTOCOL_VERSION } from "../protocol";
import { backendForkOptions } from "./fork-options";

export type BackendState = "stopped" | "starting" | "ready" | "restarting" | "failed" | "stopping";

export interface BackendExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface BackendCrash {
  readonly exit: BackendExit;
  readonly generation: number;
}

/** A child that answered its handshake: the connection to it, its generation and its answer. */
interface Ready {
  connection: MessageConnection;
  generation: number;
  initialized: InitializeResult;
}

/** What the client needs of the supervisor. */
export interface BackendLink {
  connection(): Promise<Ready>;
  /** The current child generation, 0 before the first start. */
  readonly generation: number;
  /** Read by closeIfOpen, which must never start a child. */
  readonly state: BackendState;
  readonly lastExit: BackendExit | undefined;
  readonly onWillStop: vscode.Event<void>;
  stop(): Promise<void>;
}

export interface SupervisorDeps {
  fork(modulePath: string, args: readonly string[], options: ForkOptions): ChildProcess;
  /** Where dist/backend.js lies, and the child's cwd. */
  extensionPath: string;
  log: Pick<vscode.LogOutputChannel, "info" | "warn" | "error">;
  window: Pick<typeof vscode.window, "showWarningMessage" | "showErrorMessage">;
  /** Runs libredb.showLog. */
  showLog(): Thenable<unknown>;
}

export const INITIALIZE_TIMEOUT_MS = 10_000;
/** desktop/src-tauri/src/backoff.rs RESTART_DELAYS, whose MAX_RESTARTS is its length. */
export const RESTART_DELAYS_MS: readonly number[] = [1000, 5000, 15000];
export const READY_RESET_MS = 60_000;
export const STOP_STEP_MS = 2000;
export const STDERR_TAIL_LINES = 50;
export const CRASH_WARNING = "The LibreDB backend stopped unexpectedly and is restarting.";
export const BUDGET_SPENT = "The LibreDB backend stopped 4 times in a row and was not restarted.";

const SHOW_LOG = "Show Log";
const RESTART = "Restart";
const STOPPING = "The LibreDB backend is stopping.";
const DEADLINE = `The LibreDB backend did not answer its handshake within ${INITIALIZE_TIMEOUT_MS / 1000} s.`;

export class BackendUnavailableError extends Error {
  constructor(
    message: string,
    readonly state: BackendState,
  ) {
    super(message);
    this.name = "BackendUnavailableError";
  }
}

/** One forked child, from its fork to its end. */
interface Child {
  readonly process: ChildProcess;
  readonly connection: MessageConnection;
  readonly generation: number;
  /** The last STDERR_TAIL_LINES lines the child wrote to stderr. */
  readonly stderrTail: string[];
  readonly initialize: Promise<InitializeResult>;
  readonly exited: Promise<BackendExit>;
  /** handshake until it answers initialize; ended once the supervisor is done with it. */
  phase: "handshake" | "ready" | "ended";
  /** Set once the supervisor asked the child to end, so its exit is no crash. */
  expectedExit: boolean;
}

function exitSentence({ exitCode, signal }: BackendExit): string {
  return `The LibreDB backend exited (exit code ${exitCode ?? "none"}, signal ${signal ?? "none"}).`;
}

function exitLog(exit: BackendExit, tail: readonly string[]): string {
  if (tail.length === 0) return `${exitSentence(exit)} It wrote nothing to stderr.`;
  return [`${exitSentence(exit)} Its last ${tail.length} stderr lines:`, ...tail].join("\n");
}

/** A start that calls wait for; one nobody waits for must not reject unhandled. */
function startPromise(): PromiseWithResolvers<Ready> {
  const start = Promise.withResolvers<Ready>();
  start.promise.catch(() => undefined);
  return start;
}

/** Calls onLine with each line of the stream, as written. */
function readLines(stream: Readable, onLine: (line: string) => void): void {
  createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY }).on("line", onLine);
}

export class BackendSupervisor implements BackendLink {
  private currentState: BackendState = "stopped";
  private currentGeneration = 0;
  private child: Child | undefined;
  private ready: Ready | undefined;
  /** The start that calls made while starting or restarting wait for. */
  private pending: PromiseWithResolvers<Ready> | undefined;
  /** Crashes and failed starts in a row. */
  private failures = 0;
  /** What a call made while failed shows again. */
  private failure: { message: string; items: string[] } | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private resetTimer: ReturnType<typeof setTimeout> | undefined;
  private stopping: Promise<void> | undefined;
  private exitRecord: BackendExit | undefined;
  private readonly stateEmitter = new vscode.EventEmitter<BackendState>();
  private readonly crashEmitter = new vscode.EventEmitter<BackendCrash>();
  private readonly willStopEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeState = this.stateEmitter.event;
  /** Every crash, with the generation of the child that crashed. */
  readonly onDidCrash = this.crashEmitter.event;
  readonly onWillStop = this.willStopEmitter.event;

  constructor(private readonly deps: SupervisorDeps) {}

  get state(): BackendState {
    return this.currentState;
  }

  /** 0 before the first start, then 1, 2, ... */
  get generation(): number {
    return this.currentGeneration;
  }

  get pid(): number | undefined {
    return this.child?.process.pid;
  }

  get lastExit(): BackendExit | undefined {
    return this.exitRecord;
  }

  connection(): Promise<Ready> {
    switch (this.currentState) {
      case "stopped":
        return this.spawn();
      case "ready":
        return Promise.resolve(this.ready as Ready);
      case "stopping":
        return Promise.reject(new BackendUnavailableError(STOPPING, "stopping"));
      case "failed":
        return this.showFailure();
      default:
        // starting or restarting: share that start
        return (this.pending as PromiseWithResolvers<Ready>).promise;
    }
  }

  /** The Restart button: resets the count and starts a child. */
  async restart(): Promise<void> {
    this.failures = 0;
    await (this.currentState === "failed" ? this.spawn() : this.connection());
  }

  /** deactivate's promise: shutdown, exit, SIGTERM, SIGKILL, each step STOP_STEP_MS apart. */
  stop(): Promise<void> {
    if (this.stopping === undefined) {
      this.stopping = this.runStop().finally(() => {
        this.stopping = undefined;
      });
    }
    return this.stopping;
  }

  private setState(state: BackendState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    this.stateEmitter.fire(state);
  }

  private spawn(): Promise<Ready> {
    this.pending ??= startPromise();
    const start = this.pending;
    this.currentGeneration += 1;
    const generation = this.currentGeneration;
    const { extensionPath, log } = this.deps;
    log.info(
      `Starting the LibreDB backend (generation ${generation}) from ${process.execPath}; ELECTRON_RUN_AS_NODE in the host: ${process.env.ELECTRON_RUN_AS_NODE ?? "unset"}.`,
    );
    let proc: ChildProcess;
    try {
      proc = this.deps.fork(join(extensionPath, "dist", "backend.js"), [], backendForkOptions(extensionPath));
    } catch (error) {
      // Node's spawn throws, rather than emitting error, for any errno but EACCES, EAGAIN, EMFILE, ENFILE and ENOENT
      // (E2BIG for an environment too large, EPERM): a failed start as well.
      this.couldNotStart(error as Error);
      return start.promise;
    }
    // No trace is ever set on this connection: the params of connection/test and connection/open carry secrets.
    const connection = createMessageConnection(new IPCMessageReader(proc), new IPCMessageWriter(proc));
    const exited = Promise.withResolvers<BackendExit>();
    connection.listen();
    const child: Child = {
      process: proc,
      connection,
      generation,
      stderrTail: [],
      initialize: connection.sendRequest<InitializeResult>(METHODS.initialize, { protocolVersion: PROTOCOL_VERSION }),
      exited: exited.promise,
      phase: "handshake",
      expectedExit: false,
    };
    this.child = child;
    this.setState("starting");
    // backendForkOptions pipes both, so neither is null.
    readLines(proc.stdout as Readable, (line) => log.info(line));
    readLines(proc.stderr as Readable, (line) => {
      log.warn(line);
      child.stderrTail.push(line);
      if (child.stderrTail.length > STDERR_TAIL_LINES) child.stderrTail.shift();
    });
    proc.on("error", (error) => this.onError(child, error));
    proc.on("exit", (exitCode, signal) => {
      exited.resolve({ exitCode, signal });
      this.onExit(child, { exitCode, signal });
    });
    const deadline = setTimeout(() => this.onDeadline(child), INITIALIZE_TIMEOUT_MS);
    void child.initialize
      .then(
        (initialized) => this.onInitialized(child, initialized),
        (error: unknown) => this.onRefused(child, error),
      )
      .finally(() => clearTimeout(deadline));
    return this.pending.promise;
  }

  private onInitialized(child: Child, initialized: InitializeResult): void {
    if (child.phase !== "handshake" || this.currentState === "stopping") return;
    child.phase = "ready";
    const { node, electron, modules, platform, arch } = initialized.runtime;
    const providers = initialized.enabledProviders?.join(", ") ?? "all";
    this.deps.log.info(
      `The LibreDB backend is ready: Node ${node}, Electron ${electron ?? "none"}, modules ${modules}, ${platform}/${arch}; enabled providers: ${providers}.`,
    );
    this.ready = { connection: child.connection, generation: child.generation, initialized };
    this.setState("ready");
    this.resetTimer = setTimeout(() => {
      this.failures = 0;
    }, READY_RESET_MS);
    this.pending?.resolve(this.ready);
    this.pending = undefined;
  }

  /** A refused initialize: the same child would refuse again, so nothing restarts. */
  private onRefused(child: Child, error: unknown): void {
    if (child.phase !== "handshake" || this.currentState === "stopping") return;
    const sentence = error instanceof Error ? error.message : String(error);
    child.expectedExit = true;
    child.process.kill("SIGTERM");
    this.end(child);
    this.pending?.reject(new BackendUnavailableError(sentence, "failed"));
    this.pending = undefined;
    this.fail(sentence, [SHOW_LOG]);
  }

  private onDeadline(child: Child): void {
    child.expectedExit = true;
    child.process.kill("SIGKILL");
    this.end(child);
    this.deps.log.error(DEADLINE);
    this.afterFailure(DEADLINE);
  }

  private onError(child: Child, error: Error): void {
    if (child.phase !== "handshake") {
      this.deps.log.error(`The LibreDB backend reported an error: ${error.message}`);
      return;
    }
    child.expectedExit = true;
    this.end(child);
    this.couldNotStart(error);
  }

  /** The binary could not be spawned: a failed start. */
  private couldNotStart(error: Error): void {
    const sentence = `The LibreDB backend could not start: ${error.message}`;
    this.deps.log.error(sentence);
    this.afterFailure(sentence);
  }

  private onExit(child: Child, exit: BackendExit): void {
    if (child.expectedExit) return;
    // Recorded before the connection is disposed, so a request rejected by that disposal finds it.
    this.exitRecord = exit;
    this.end(child);
    this.deps.log.error(exitLog(exit, child.stderrTail));
    this.afterFailure(exitSentence(exit));
    // Fired once ready is cleared and the state is restarting or failed, so a listener that calls the backend waits
    // for the next child instead of reaching the one that crashed.
    this.crashEmitter.fire({ exit, generation: child.generation });
  }

  /** Disposes the child's connection, which rejects its pending requests with PendingResponseRejected. */
  private end(child: Child): void {
    child.phase = "ended";
    child.connection.dispose();
  }

  /** A crash or a failed start: a restart within the budget, else failed. */
  private afterFailure(sentence: string): void {
    if (this.currentState === "stopping") return;
    this.ready = undefined;
    clearTimeout(this.resetTimer);
    const waiting = this.pending;
    this.pending = undefined;
    if (this.failures === RESTART_DELAYS_MS.length) {
      waiting?.reject(new BackendUnavailableError(sentence, "failed"));
      this.fail(BUDGET_SPENT, [SHOW_LOG, RESTART]);
      return;
    }
    const delay = RESTART_DELAYS_MS[this.failures];
    this.failures += 1;
    this.pending = startPromise();
    this.setState("restarting");
    waiting?.reject(new BackendUnavailableError(sentence, "restarting"));
    this.restartTimer = setTimeout(() => {
      void this.spawn();
    }, delay);
    void this.deps.window.showWarningMessage(CRASH_WARNING, SHOW_LOG).then((answer) => {
      if (answer === SHOW_LOG) void this.deps.showLog();
    });
  }

  private fail(message: string, items: string[]): void {
    this.failure = { message, items };
    this.setState("failed");
    void this.showFailure().catch(() => undefined);
  }

  /** Shows the failure again and rejects with it. */
  private showFailure(): Promise<never> {
    const { message, items } = this.failure as { message: string; items: string[] };
    void this.deps.window.showErrorMessage(message, ...items).then((answer) => {
      if (answer === SHOW_LOG) void this.deps.showLog();
      // A start that fails again is reported by its own failure path.
      if (answer === RESTART) void this.restart().catch(() => undefined);
    });
    return Promise.reject(new BackendUnavailableError(message, "failed"));
  }

  private async runStop(): Promise<void> {
    this.willStopEmitter.fire();
    clearTimeout(this.restartTimer);
    clearTimeout(this.resetTimer);
    const child = this.child;
    const live = this.currentState === "starting" || this.currentState === "ready";
    this.ready = undefined;
    const waiting = this.pending;
    this.pending = undefined;
    if (!live || child === undefined) {
      waiting?.reject(new BackendUnavailableError(STOPPING, "stopped"));
      this.setState("stopped");
      return;
    }
    child.expectedExit = true;
    this.setState("stopping");
    waiting?.reject(new BackendUnavailableError(STOPPING, "stopping"));
    // A handshake in flight ends first: the child refuses every request before it.
    await child.initialize.catch(() => undefined);
    await this.endChild(child);
    this.end(child);
    this.setState("stopped");
  }

  private async endChild(child: Child): Promise<void> {
    const shutdown = Promise.resolve().then(() => child.connection.sendRequest(METHODS.shutdown));
    if (await within(shutdown, STOP_STEP_MS)) {
      void child.connection.sendNotification(EXIT_NOTIFICATION);
      if (await within(child.exited, STOP_STEP_MS)) return;
    }
    child.process.kill("SIGTERM");
    if (await within(child.exited, STOP_STEP_MS)) return;
    child.process.kill("SIGKILL");
  }
}

/** Whether the promise fulfils within ms; a rejection counts as no. */
function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const settled = promise.then(
    () => true,
    () => false,
  );
  return Promise.race([settled, late]).finally(() => clearTimeout(timer));
}
