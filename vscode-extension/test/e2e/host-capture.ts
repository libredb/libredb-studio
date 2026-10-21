// The e2e leg's seam to what the editors and the Results view publish: activate exports nothing by design, so a test
// reads the context keys, the LibreDB log, the status bar item and the Results view by wrapping
// window.createStatusBarItem, window.createOutputChannel, window.registerWebviewViewProvider and
// commands.executeCommand on the vscode API object the extension host hands both the extension and the test files,
// before the extension activates. Each test file is bundled on its own, so the capture lives on that shared object and
// on globalThis, never in this module's own state.
import * as vscode from "vscode";
import { RESULTS_VIEW, STATUS_ITEM } from "../../src/host/names";

export interface HostCapture {
  /** Every setContext call since the install, in order. */
  readonly contexts: ReadonlyArray<{ readonly key: string; readonly value: unknown }>;
  /** The LibreDB log's lines, info, warn and error, in order. */
  readonly logLines: readonly string[];
  /** The libredb.connection status bar item, once created, and whether it is shown. */
  statusItem(): { readonly item: vscode.StatusBarItem; readonly shown: boolean };
  /** The Results view's capture: resolves, posted and received messages, and a sender standing in for the webview. */
  results(): ResultsCapture;
}

export interface ResultsCapture {
  /** How many times VS Code resolved the view. */
  readonly resolves: number;
  /** Every message the host handed the view's postMessage, in order. */
  readonly posted: readonly unknown[];
  /** Every message the real webview sent, in order; what send hands the host is not among them. */
  readonly received: readonly unknown[];
  /** The view's description as the host last set it. */
  readonly description: string | undefined;
  /** Hands raw to the host's message listeners, as the webview's postMessage would. */
  send(raw: unknown): void;
}

/** The log channel whose lines are kept: the extension's own. */
const LOG_NAME = "LibreDB";

const MARK = Symbol.for("libredb.e2e.hostCapture");

interface ResultsState {
  resolves: number;
  readonly posted: unknown[];
  readonly received: unknown[];
  /** The resolved view, as VS Code handed it to the wrapper. */
  view: vscode.WebviewView | undefined;
  /** The host's message listeners on the view's webview, registered through the wrapper. */
  readonly listeners: Set<(raw: unknown) => unknown>;
}

interface State {
  readonly contexts: { readonly key: string; readonly value: unknown }[];
  readonly logLines: string[];
  status: { readonly item: vscode.StatusBarItem; shown: boolean } | undefined;
  readonly results: ResultsState;
}

/** The capture's state, kept on globalThis so every bundle reads the same one. */
function state(): State {
  const holder = globalThis as { [MARK]?: State };
  holder[MARK] ??= {
    contexts: [],
    logLines: [],
    status: undefined,
    results: { resolves: 0, posted: [], received: [], view: undefined, listeners: new Set() },
  };
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

/** A member of target read with target as its receiver, a function bound to it, since the API objects keep private state. */
function memberOf(target: object, key: string | symbol): unknown {
  const value: unknown = Reflect.get(target, key, target);
  return typeof value === "function" ? value.bind(target) : value;
}

/** The webview with postMessage and onDidReceiveMessage recording into the capture; every other member as it is. */
function recordingWebview(webview: vscode.Webview, results: ResultsState): vscode.Webview {
  const postMessage = (message: unknown) => {
    results.posted.push(message);
    return webview.postMessage(message);
  };
  const onDidReceiveMessage = (
    listener: (raw: unknown) => unknown,
    thisArgs?: unknown,
    disposables?: vscode.Disposable[],
  ) => {
    const bound = (raw: unknown) => listener.call(thisArgs, raw);
    results.listeners.add(bound);
    const real = webview.onDidReceiveMessage((raw: unknown) => {
      results.received.push(raw);
      bound(raw);
    });
    const disposable = new vscode.Disposable(() => {
      results.listeners.delete(bound);
      real.dispose();
    });
    disposables?.push(disposable);
    return disposable;
  };
  return new Proxy(webview, {
    get: (target, key) => {
      if (key === "postMessage") return postMessage;
      if (key === "onDidReceiveMessage") return onDidReceiveMessage;
      return memberOf(target, key);
    },
    set: (target, key, value) => Reflect.set(target, key, value, target),
  });
}

/** The view with its webview recording; every other member, the description included, read and set on the view. */
function recordingView(view: vscode.WebviewView, results: ResultsState): vscode.WebviewView {
  const webview = recordingWebview(view.webview, results);
  return new Proxy(view, {
    get: (target, key) => (key === "webview" ? webview : memberOf(target, key)),
    set: (target, key, value) => Reflect.set(target, key, value, target),
  });
}

/**
 * Wraps window.createStatusBarItem, window.createOutputChannel, window.registerWebviewViewProvider and
 * commands.executeCommand once per host; idempotent.
 */
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
  replace(vscode.window, "registerWebviewViewProvider", (original) => {
    const bound = original.bind(vscode.window);
    return ((viewId: string, provider: vscode.WebviewViewProvider, options?: Parameters<typeof bound>[2]) => {
      if (viewId !== RESULTS_VIEW) return bound(viewId, provider, options);
      const { results } = captured;
      const recording: vscode.WebviewViewProvider = {
        resolveWebviewView: (view, context, token) => {
          results.resolves += 1;
          results.view = view;
          return provider.resolveWebviewView(recordingView(view, results), context, token);
        },
      };
      return bound(viewId, recording, options);
    }) as typeof vscode.window.registerWebviewViewProvider;
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
    results() {
      const { results } = captured;
      return {
        get resolves() {
          return results.resolves;
        },
        posted: results.posted,
        received: results.received,
        get description() {
          return results.view?.description;
        },
        send(raw: unknown) {
          if (results.listeners.size === 0) {
            throw new Error("The Results view has no message listener; was it resolved after the capture?");
          }
          for (const listener of results.listeners) listener(raw);
        },
      };
    },
  };
}

/** The last published value of a context key; throws when it was never published. */
export function contextValue(key: string): readonly string[] {
  const published = state().contexts.findLast((context) => context.key === key);
  if (published === undefined) throw new Error(`${key} was never published.`);
  return published.value as readonly string[];
}
