// The Results webview view (part 4, "Registration and lifecycle" and "The theming bridge"): it renders the document,
// posts only to a live, visible view, answers every ready with init and the replay, and follows the colour theme.
// Resolving it starts no backend: the HTML, the theme and the empty state need none. What the view sends is held to
// the guard first (part 4, "The message protocol"): a refused message changes nothing and is logged naming its field.
import * as vscode from "vscode";
import {
  type HostToWebview,
  parseWebviewMessage,
  ResultsProtocolError,
  type ThemeKind,
  type WebviewToHost,
} from "../../results-protocol";
import { RESULTS_VIEW } from "../names";
import { renderResultsHtml } from "./html";
import type { ResultsSession, ResultsSurface } from "./results-presenter";

export interface ResultsViewDeps {
  readonly extensionUri: vscode.Uri;
  readonly window: Pick<
    typeof vscode.window,
    "activeColorTheme" | "onDidChangeActiveColorTheme" | "setStatusBarMessage" | "showWarningMessage"
  >;
  readonly commands: Pick<typeof vscode.commands, "executeCommand">;
  /** env.clipboard: the only writer of the system clipboard the view has (part 4, "Copy and export"). */
  readonly clipboard: Pick<vscode.Clipboard, "writeText">;
  readonly log: Pick<vscode.LogOutputChannel, "warn" | "error">;
  /** The presenter, reached through a closure. */
  readonly session: ResultsSession;
  /** newNonce in activate; a test passes a counter. */
  newNonce(): string;
}

/** How much of a refusal's "<field>: <reason>" reaches the log: the reason can carry text the view chose. */
const REFUSAL_DETAIL_CHARS = 200;

/** "The LibreDB Results view sent a message the host refused: <field>: <reason>.", cut to a bounded detail. */
export function refusedMessage(error: ResultsProtocolError): string {
  const detail =
    error.message.length > REFUSAL_DETAIL_CHARS
      ? `${error.message.slice(0, REFUSAL_DETAIL_CHARS)} (cut)`
      : error.message;
  return `The LibreDB Results view sent a message the host refused: ${detail}.`;
}

/** "The LibreDB Results view reported an error: <message>" */
export const reportedError = (message: string): string => `The LibreDB Results view reported an error: ${message}`;

/**
 * A notice's text with every square bracket removed. VS Code's notification renders [label](href) as a link and
 * opens it with command URIs allowed, so the view's text never reaches it with link syntax intact (trust rule 4).
 */
function plainNotice(message: string): string {
  return message.replace(/[[\]]/g, "");
}

/** How long an info notice stays in the status bar, in milliseconds. */
const STATUS_NOTICE_MS = 3000;

const THEME_KINDS: Readonly<Record<vscode.ColorThemeKind, ThemeKind>> = {
  [vscode.ColorThemeKind.Light]: "light",
  [vscode.ColorThemeKind.Dark]: "dark",
  [vscode.ColorThemeKind.HighContrast]: "highContrast",
  [vscode.ColorThemeKind.HighContrastLight]: "highContrastLight",
};

/** ColorThemeKind Light 1, Dark 2, HighContrast 3, HighContrastLight 4 to the protocol's ThemeKind. */
export function themeKindOf(kind: vscode.ColorThemeKind): ThemeKind {
  return THEME_KINDS[kind];
}

export class ResultsViewProvider implements vscode.WebviewViewProvider, ResultsSurface, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private description: string | undefined;
  private readonly themeListener: vscode.Disposable;

  constructor(private readonly deps: ResultsViewDeps) {
    this.themeListener = deps.window.onDidChangeActiveColorTheme((theme) =>
      this.post({ v: 1, type: "theme", theme: themeKindOf(theme.kind) }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const root = vscode.Uri.joinPath(this.deps.extensionUri, "dist", "webview");
    // Trust rule 6: scripts on, forms off, command URIs off (the default), resources from dist/webview only.
    view.webview.options = { enableScripts: true, enableForms: false, localResourceRoots: [root] };
    view.webview.html = renderResultsHtml({
      cspSource: view.webview.cspSource,
      nonce: this.deps.newNonce(),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(root, "results.js")).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(root, "results.css")).toString(),
    });
    const listeners = [
      view.webview.onDidReceiveMessage((raw: unknown) => this.receive(raw)),
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined;
        for (const listener of listeners) listener.dispose();
      }),
    ];
    view.description = this.description;
  }

  /** Posts to a live, visible view; postMessage's boolean means posted, not received, so it is not read. */
  post(message: HostToWebview): void {
    if (this.view?.visible) void this.view.webview.postMessage(message);
  }

  /** Shows the view without taking focus: show(true) on a resolved view, the focus command otherwise. */
  reveal(): void {
    if (this.view !== undefined) {
      this.view.show(true);
      return;
    }
    this.deps.commands.executeCommand(`${RESULTS_VIEW}.focus`, { preserveFocus: true }).then(undefined, (error) => {
      this.deps.log.error(`Revealing the LibreDB Results view failed: ${messageOf(error)}`);
    });
  }

  /** "<document label> on <connection name>", kept for the next resolve and set at once on a resolved view. */
  describe(description: string | undefined): void {
    this.description = description;
    if (this.view !== undefined) this.view.description = description;
  }

  dispose(): void {
    this.themeListener.dispose();
  }

  /** Every message the webview sends is held to the guard before the host acts on it; a refusal is logged. */
  private receive(raw: unknown): void {
    let message: WebviewToHost;
    try {
      message = parseWebviewMessage(raw);
    } catch (error) {
      if (!(error instanceof ResultsProtocolError)) throw error;
      this.deps.log.warn(refusedMessage(error));
      return;
    }
    switch (message.type) {
      case "ready":
        this.post({ v: 1, type: "init", theme: themeKindOf(this.deps.window.activeColorTheme.kind) });
        for (const replayed of this.deps.session.replay()) this.post(replayed);
        return;
      case "loadMore":
        // Trust rule 3 is the session's: the view names a run, and the host holds everything a read needs.
        void this.deps.session.loadMore(message.runId);
        return;
      case "copy":
        void this.copy(message.requestId, message.text);
        return;
      case "notify":
        if (message.level === "info")
          this.deps.window.setStatusBarMessage(plainNotice(message.message), STATUS_NOTICE_MS);
        else void this.deps.window.showWarningMessage(plainNotice(message.message));
        return;
    }
    // Only reportError is left; a message type added to the protocol without a case above fails this assignment.
    const report: Extract<WebviewToHost, { type: "reportError" }> = message;
    this.deps.log.error(reportedError(report.message));
  }

  /** Writes text to the clipboard and answers copied with whether the write settled. */
  private async copy(requestId: number, text: string): Promise<void> {
    let ok = true;
    try {
      await this.deps.clipboard.writeText(text);
    } catch (error) {
      ok = false;
      this.deps.log.error(`The LibreDB Results view could not write the clipboard: ${messageOf(error)}`);
    }
    this.post({ v: 1, type: "copied", requestId, ok });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
