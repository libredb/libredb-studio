// The e2e leg's seam to what the editors publish: activate exports nothing by design, so a test reads the context keys,
// the LibreDB log and the status bar item by wrapping window.createStatusBarItem, window.createOutputChannel and
// commands.executeCommand on the vscode API object the extension host hands both the extension and the test files,
// before the extension activates. Each test file is bundled on its own, so the capture lives on that shared object and
// on globalThis, never in this module's own state.
import * as vscode from "vscode";
import { STATUS_ITEM } from "../../src/host/names";

export interface HostCapture {
  /** Every setContext call since the install, in order. */
  readonly contexts: ReadonlyArray<{ readonly key: string; readonly value: unknown }>;
  /** The LibreDB log's lines, info, warn and error, in order. */
  readonly logLines: readonly string[];
  /** The libredb.connection status bar item, once created, and whether it is shown. */
  statusItem(): { readonly item: vscode.StatusBarItem; readonly shown: boolean };
}

/** The log channel whose lines are kept: the extension's own. */
const LOG_NAME = "LibreDB";

const MARK = Symbol.for("libredb.e2e.hostCapture");

interface State {
  readonly contexts: { readonly key: string; readonly value: unknown }[];
  readonly logLines: string[];
  status: { readonly item: vscode.StatusBarItem; shown: boolean } | undefined;
}

/** The capture's state, kept on globalThis so every bundle reads the same one. */
function state(): State {
  const holder = globalThis as { [MARK]?: State };
  holder[MARK] ??= { contexts: [], logLines: [], status: undefined };
  return holder[MARK];
}

type Mutable<T, K extends keyof T> = { -readonly [P in K]: T[P] };

/** Replaces one function of an API namespace, marked so a second install finds it, and checks the replacement held. */
function replace<T extends object, K extends keyof T>(target: T, key: K, wrap: (original: T[K]) => T[K]): void {
  const original = target[key];
  if ((original as { [MARK]?: true })[MARK] === true) return;
  const wrapped = wrap(original);
  Object.defineProperty(wrapped, MARK, { value: true });
  (target as Mutable<T, K>)[key] = wrapped;
  if (target[key] !== wrapped) throw new Error(`vscode's ${String(key)} could not be replaced.`);
}

/** A log channel whose info, warn and error also append their line to the capture; the channel's other members as they are. */
function recordingChannel(channel: vscode.LogOutputChannel): vscode.LogOutputChannel {
  const { logLines } = state();
  const recorded = (level: "info" | "warn" | "error") => ({
    value: (message: string | Error, ...args: unknown[]) => {
      logLines.push(message instanceof Error ? message.message : message);
      (channel[level] as (message: string | Error, ...args: unknown[]) => void)(message, ...args);
    },
  });
  // A derived object, since the extension host may hand out a frozen channel.
  return Object.create(channel, {
    info: recorded("info"),
    warn: recorded("warn"),
    error: recorded("error"),
  }) as vscode.LogOutputChannel;
}

/** Wraps window.createStatusBarItem, window.createOutputChannel and commands.executeCommand once per host; idempotent. */
export function installHostCapture(): void {
  const captured = state();
  replace(vscode.commands, "executeCommand", (original) => {
    const bound = original.bind(vscode.commands);
    return ((command: string, ...rest: unknown[]) => {
      if (command === "setContext") captured.contexts.push({ key: rest[0] as string, value: rest[1] });
      return bound(command, ...rest);
    }) as typeof vscode.commands.executeCommand;
  });
  replace(vscode.window, "createOutputChannel", (original) => {
    const bound = original.bind(vscode.window) as (name: string, options?: unknown) => vscode.OutputChannel;
    return ((name: string, options?: unknown) => {
      const channel = bound(name, options);
      const isLog = typeof options === "object" && options !== null && (options as { log?: unknown }).log === true;
      return name === LOG_NAME && isLog ? recordingChannel(channel as vscode.LogOutputChannel) : channel;
    }) as typeof vscode.window.createOutputChannel;
  });
  replace(vscode.window, "createStatusBarItem", (original) => {
    const bound = original.bind(vscode.window) as (...args: unknown[]) => vscode.StatusBarItem;
    return ((...args: unknown[]) => {
      const item = bound(...args);
      if (item.id !== STATUS_ITEM) return item;
      const record = { item, shown: false };
      captured.status = record;
      const show = item.show.bind(item);
      const hide = item.hide.bind(item);
      item.show = () => {
        record.shown = true;
        show();
      };
      item.hide = () => {
        record.shown = false;
        hide();
      };
      return item;
    }) as typeof vscode.window.createStatusBarItem;
  });
}

export function hostCapture(): HostCapture {
  const captured = state();
  return {
    contexts: captured.contexts,
    logLines: captured.logLines,
    statusItem() {
      if (captured.status === undefined) {
        throw new Error(
          "The libredb.connection status bar item was not created; was the extension active before the capture?",
        );
      }
      return captured.status;
    },
  };
}

/** The last published value of a context key; throws when it was never published. */
export function contextValue(key: string): readonly string[] {
  const published = state().contexts.findLast((context) => context.key === key);
  if (published === undefined) throw new Error(`${key} was never published.`);
  return published.value as readonly string[];
}
