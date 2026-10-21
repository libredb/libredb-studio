/**
 * The fake `vscode` module of the unit leg: `tsconfig.test.json` maps the `vscode` specifier here, so host code under
 * test calls these doubles instead of a real extension host.
 * It implements only the surface the host code calls, and each export is typed against `@types/vscode`, so a fake that
 * disagrees with the 1.120.0 typings fails the typecheck.
 * The e2e leg checks the real API behind it.
 */
import type * as vscode from "vscode";
import { ScriptedQuickInputs } from "./quick-input";
import { MemorySecretStorage } from "./secret-storage";

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
  /** Present only when the caller passed MessageOptions, a modal dialog's among them. */
  readonly options?: vscode.MessageOptions;
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

/** The real overloads take MessageOptions before the items, as an object where an item is a string. */
function show(
  level: ShownMessage["level"],
  message: string,
  rest: (string | vscode.MessageOptions)[],
): Thenable<string | undefined> {
  const [first, ...others] = rest;
  const shown: ShownMessage =
    typeof first === "object"
      ? { level, message, options: first, items: others as string[] }
      : { level, message, items: rest as string[] };
  shownMessages.push(shown);
  return Promise.resolve(answerMessage(shown));
}

/** An input box `window.showInputBox` showed, by the options it was given. */
export const shownInputBoxes: vscode.InputBoxOptions[] = [];

/** How the fake person answers an input box: what they type, or undefined for Escape. */
type InputBoxAnswer = (options: vscode.InputBoxOptions) => string | undefined;

let answerInputBox: InputBoxAnswer = () => undefined;

/** Scripts the answer to every input box shown from now on. */
export function answerInputBoxes(answer: InputBoxAnswer): void {
  answerInputBox = answer;
}

/** A quick pick `window.showQuickPick` showed: its items, resolved, and its options. */
export interface ShownQuickPick {
  readonly items: readonly vscode.QuickPickItem[];
  readonly options: vscode.QuickPickOptions | undefined;
}

/** Every quick pick `window.showQuickPick` showed since the last reset, in order. */
export const shownQuickPicks: ShownQuickPick[] = [];

/** How the fake person answers a quick pick: the item they choose, or undefined for Escape. */
type QuickPickAnswer = (shown: ShownQuickPick) => vscode.QuickPickItem | undefined;

let answerQuickPick: QuickPickAnswer = () => undefined;

/** Scripts the answer to every quick pick `window.showQuickPick` shows from now on. */
export function answerQuickPicks(answer: QuickPickAnswer): void {
  answerQuickPick = answer;
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
 * vscode.ThemeIcon: an icon of the current theme, by its id.
 * The code under test reaches this through tsconfig.test.json's "vscode" alias, which knip does not read.
 * @public
 */
export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: vscode.ThemeColor,
  ) {}
}

/**
 * vscode.QuickInputButtons: the Back button, one object for the whole host, as in VS Code.
 * The code under test reaches this through tsconfig.test.json's "vscode" alias, which knip does not read.
 * @public
 */
export const QuickInputButtons = { Back: { iconPath: new ThemeIcon("arrow-left") } } satisfies Pick<
  typeof vscode.QuickInputButtons,
  "Back"
>;

/**
 * vscode.QuickPickItemKind, with the real enum's values.
 * The code under test reaches this through tsconfig.test.json's "vscode" alias, which knip does not read.
 * @public
 */
export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

/** The quick inputs `window.createQuickPick` and `window.createInputBox` created since the last reset, scripted by a test. */
export const quickInputs = new ScriptedQuickInputs(QuickInputButtons.Back);

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
  showWarningMessage: ((message: string, ...rest: (string | vscode.MessageOptions)[]) =>
    show("warning", message, rest)) as typeof vscode.window.showWarningMessage,
  showErrorMessage: ((message: string, ...rest: (string | vscode.MessageOptions)[]) =>
    show("error", message, rest)) as typeof vscode.window.showErrorMessage,
  showInputBox(options: vscode.InputBoxOptions = {}): Thenable<string | undefined> {
    shownInputBoxes.push(options);
    return Promise.resolve(answerInputBox(options));
  },
  // The real overloads answer the item type each caller passes; the fake answers the item the test scripted.
  showQuickPick: (async (
    items: readonly (string | vscode.QuickPickItem)[] | Thenable<readonly (string | vscode.QuickPickItem)[]>,
    options?: vscode.QuickPickOptions,
  ) => {
    // The host code passes QuickPickItems only.
    const shown: ShownQuickPick = { items: (await items) as readonly vscode.QuickPickItem[], options };
    shownQuickPicks.push(shown);
    return answerQuickPick(shown);
  }) as typeof vscode.window.showQuickPick,
  createQuickPick<T extends vscode.QuickPickItem>(): vscode.QuickPick<T> {
    return quickInputs.createQuickPick<T>();
  },
  createInputBox(): vscode.InputBox {
    return quickInputs.createInputBox();
  },
} satisfies Pick<
  typeof vscode.window,
  | "createOutputChannel"
  | "showWarningMessage"
  | "showErrorMessage"
  | "showInputBox"
  | "showQuickPick"
  | "createQuickPick"
  | "createInputBox"
>;

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

/**
 * vscode.CancellationTokenSource: cancel() sets the token's flag and fires onCancellationRequested once.
 * The code under test reaches this through tsconfig.test.json's "vscode" alias, which knip does not read.
 * @public
 */
export class CancellationTokenSource implements vscode.CancellationTokenSource {
  private readonly cancellations = new EventEmitter<void>();
  readonly token: vscode.CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: this.cancellations.event,
  };

  cancel(): void {
    if (this.token.isCancellationRequested) return;
    this.token.isCancellationRequested = true;
    this.cancellations.fire();
  }

  dispose(): void {
    this.cancellations.dispose();
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

/** An extension context holding only what the host code reads; each call has its own empty MemorySecretStorage. */
export function fakeExtensionContext(): Pick<vscode.ExtensionContext, "subscriptions" | "extensionPath" | "secrets"> {
  return { subscriptions: [], extensionPath: "/ext", secrets: new MemorySecretStorage() };
}

/**
 * vscode.ConfigurationTarget, with the real enum's values.
 * The code under test reaches this through tsconfig.test.json's "vscode" alias, which knip does not read.
 * @public
 */
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

/** The settings the fake workspace holds, by full key ("libredb.connections"); a test may set one directly. */
export const settings = new Map<string, unknown>();

/** One `update` a configuration the fake workspace gave out received. */
export interface ConfigurationUpdate {
  readonly section: string | undefined;
  readonly key: string;
  readonly value: unknown;
  readonly target: unknown;
}

/** Every `update` since the last reset, in order. */
export const configurationUpdates: ConfigurationUpdate[] = [];

/** The full key of every `get` since the last reset, in order. */
export const configurationReads: string[] = [];

const configurationChanges = new EventEmitter<vscode.ConfigurationChangeEvent>();

/** The full key of a setting: "libredb" and "connections" make "libredb.connections". */
function fullKey(section: string | undefined, key: string): string {
  return section === undefined ? key : `${section}.${key}`;
}

/** Fires `onDidChangeConfiguration` for these full keys, as an edit of user settings does. */
export function changeConfiguration(...keys: string[]): void {
  configurationChanges.fire({
    affectsConfiguration: (section) => keys.some((key) => key === section || key.startsWith(`${section}.`)),
  });
}

/**
 * The code under test reaches this through tsconfig.test.json's "vscode" alias, which knip does not read.
 * @public
 */
export const workspace = {
  getConfiguration(section?: string): vscode.WorkspaceConfiguration {
    return {
      get: (key: string, defaultValue?: unknown) => {
        configurationReads.push(fullKey(section, key));
        return settings.get(fullKey(section, key)) ?? defaultValue;
      },
      has: (key: string) => settings.has(fullKey(section, key)),
      inspect: () => undefined,
      // VS Code fires onDidChangeConfiguration for an extension's own update too.
      update: (key: string, value: unknown, target?: unknown) => {
        configurationUpdates.push({ section, key, value, target });
        settings.set(fullKey(section, key), value);
        changeConfiguration(fullKey(section, key));
        return Promise.resolve();
      },
    };
  },
  onDidChangeConfiguration: configurationChanges.event,
  /** Whether the workspace is trusted; a test sets it false for Restricted Mode. */
  isTrusted: true as boolean,
} satisfies Pick<typeof vscode.workspace, "getConfiguration" | "onDidChangeConfiguration" | "isTrusted">;

/**
 * Forget every channel, command, notification, scripted answer, quick input and setting, and trust the workspace again,
 * so each test starts from an empty host.
 */
export function resetFake(): void {
  outputChannels.length = 0;
  registeredCommands.clear();
  shownMessages.length = 0;
  answerMessage = () => undefined;
  shownInputBoxes.length = 0;
  answerInputBox = () => undefined;
  shownQuickPicks.length = 0;
  answerQuickPick = () => undefined;
  settings.clear();
  configurationUpdates.length = 0;
  configurationReads.length = 0;
  configurationChanges.dispose();
  quickInputs.reset();
  workspace.isTrusted = true;
}
