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
  /** How many times `show` ran. */
  shown: number;
  /** Whether `dispose` ran. */
  disposed: boolean;
}

/** Every channel `window.createOutputChannel` created since the last reset, in order. */
export const outputChannels: FakeLogOutputChannel[] = [];

/** The commands registered and not yet disposed, by id. */
export const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

export class Disposable implements vscode.Disposable {
  constructor(private readonly callOnDispose: () => void) {}

  dispose(): void {
    this.callOnDispose();
  }
}

class LogChannel implements FakeLogOutputChannel {
  // LogLevel.Info: the enum is a runtime value of the real module, which this fake does not load.
  readonly logLevel = 3 as vscode.LogLevel;
  shown = 0;
  disposed = false;

  constructor(
    readonly name: string,
    readonly options: unknown,
  ) {}

  onDidChangeLogLevel: vscode.Event<vscode.LogLevel> = () => new Disposable(() => {});
  trace(): void {}
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
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
} satisfies Pick<typeof vscode.window, "createOutputChannel">;

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
export function fakeExtensionContext(): Pick<vscode.ExtensionContext, "subscriptions"> {
  return { subscriptions: [] };
}

/** Forget every channel and command, so each test starts from an empty host. */
export function resetFake(): void {
  outputChannels.length = 0;
  registeredCommands.clear();
}
