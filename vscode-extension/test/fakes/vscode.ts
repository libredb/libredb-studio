/**
 * The fake `vscode` module of the unit leg: `tsconfig.test.json` maps the `vscode` specifier here, so host code under
 * test calls these doubles instead of a real extension host.
 * It implements only the surface the host code calls, and each export is typed against `@types/vscode`, so a fake that
 * disagrees with the 1.120.0 typings fails the typecheck.
 * The e2e leg checks the real API behind it.
 */
import type * as vscode from "vscode";

/** A log channel the fake `window` created, with what a test needs to read back. */
export interface FakeLogOutputChannel extends vscode.LogOutputChannel {
  /** The options `createOutputChannel` received. */
  readonly options: unknown;
  /** What `info`, `warn` and `error` wrote, as `[level, message]`, in order. */
  readonly lines: [string, string][];
  /** How many times `show` ran. */
  shown: number;
  /** Whether `dispose` ran. */
  disposed: boolean;
}

/** Every channel `window.createOutputChannel` created since the last reset, in order. */
export const outputChannels: FakeLogOutputChannel[] = [];

/** The commands registered and not yet disposed, by id. */
export const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

/** A notification `window.showWarningMessage` or `window.showErrorMessage` showed. */
export interface ShownMessage {
  readonly level: "warning" | "error";
  readonly message: string;
  readonly items: readonly string[];
}

/** Every notification shown since the last reset, in order. */
export const shownMessages: ShownMessage[] = [];

/** How the fake person answers a notification: the item they choose, or undefined when they dismiss it. */
type MessageAnswer = (shown: ShownMessage) => string | undefined;

let answerMessage: MessageAnswer = () => undefined;

/** Scripts the answer to every notification shown from now on. */
export function answerMessages(answer: MessageAnswer): void {
  answerMessage = answer;
}

function show(level: ShownMessage["level"], message: string, items: string[]): Thenable<string | undefined> {
  const shown = { level, message, items };
  shownMessages.push(shown);
  return Promise.resolve(answerMessage(shown));
}

export class Disposable implements vscode.Disposable {
  constructor(private readonly callOnDispose: () => void) {}

  dispose(): void {
    this.callOnDispose();
  }
}

class LogChannel implements FakeLogOutputChannel {
  // LogLevel.Info: the enum is a runtime value of the real module, which this fake does not load.
  readonly logLevel = 3 as vscode.LogLevel;
  readonly lines: [string, string][] = [];
  shown = 0;
  disposed = false;

  constructor(
    readonly name: string,
    readonly options: unknown,
  ) {}

  onDidChangeLogLevel: vscode.Event<vscode.LogLevel> = () => new Disposable(() => {});
  trace(): void {}
  debug(): void {}
  info(message: string): void {
    this.lines.push(["info", message]);
  }
  warn(message: string): void {
    this.lines.push(["warn", message]);
  }
  error(error: string | Error): void {
    this.lines.push(["error", String(error)]);
  }
  append(): void {}
  appendLine(): void {}
  replace(): void {}
  clear(): void {}
  show(): void {
    this.shown += 1;
  }
  hide(): void {}
  dispose(): void {
    this.disposed = true;
  }
}

/**
 * The code under test reaches this through tsconfig.test.json's "vscode" alias, which knip does not read.
 * @public
 */
export const window = {
  createOutputChannel(name: string, options?: unknown): FakeLogOutputChannel {
    const channel = new LogChannel(name, options);
    outputChannels.push(channel);
    return channel;
  },
  // The real overloads answer the item type each caller passes; the fake answers whatever the test scripted.
  showWarningMessage: ((message: string, ...items: string[]) =>
    show("warning", message, items)) as typeof vscode.window.showWarningMessage,
  showErrorMessage: ((message: string, ...items: string[]) =>
    show("error", message, items)) as typeof vscode.window.showErrorMessage,
} satisfies Pick<typeof vscode.window, "createOutputChannel" | "showWarningMessage" | "showErrorMessage">;

/**
 * vscode.EventEmitter: listeners run in the order they subscribed, each until its Disposable is disposed.
 * The code under test reaches this through tsconfig.test.json's "vscode" alias, which knip does not read.
 * @public
 */
export class EventEmitter<T> implements vscode.EventEmitter<T> {
  private listeners: ((event: T) => unknown)[] = [];

  readonly event: vscode.Event<T> = (listener, thisArgs?, disposables?) => {
    const bound = (event: T) => listener.call(thisArgs, event);
    this.listeners.push(bound);
    const disposable = new Disposable(() => {
      this.listeners = this.listeners.filter((each) => each !== bound);
    });
    disposables?.push(disposable);
    return disposable;
  };

  fire(data: T): void {
    for (const listener of [...this.listeners]) listener(data);
  }

  dispose(): void {
    this.listeners = [];
  }
}

export const commands = {
  registerCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable {
    if (registeredCommands.has(command)) {
      throw new Error(`command '${command}' already exists`);
    }
    registeredCommands.set(command, callback);
    return new Disposable(() => registeredCommands.delete(command));
  },
  executeCommand<T = unknown>(command: string, ...rest: unknown[]): Thenable<T> {
    const callback = registeredCommands.get(command);
    if (!callback) {
      return Promise.reject(new Error(`command '${command}' not found`));
    }
    return Promise.resolve(callback(...rest) as T);
  },
} satisfies Pick<typeof vscode.commands, "registerCommand" | "executeCommand">;

/** An extension context holding only what the host code reads. */
export function fakeExtensionContext(): Pick<vscode.ExtensionContext, "subscriptions" | "extensionPath"> {
  return { subscriptions: [], extensionPath: "/ext" };
}

/** Forget every channel, command, notification and scripted answer, so each test starts from an empty host. */
export function resetFake(): void {
  outputChannels.length = 0;
  registeredCommands.clear();
  shownMessages.length = 0;
  answerMessage = () => undefined;
}
