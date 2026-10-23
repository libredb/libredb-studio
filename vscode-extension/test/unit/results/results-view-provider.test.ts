import assert from "node:assert/strict";
import type * as vscode from "vscode";
import { RADIX_SCROLL_AREA_STYLE_HASH } from "../../../src/host/results/csp";
import { renderResultsHtml } from "../../../src/host/results/html";
import type { ResultsSession } from "../../../src/host/results/results-presenter";
import {
  ResultsViewProvider,
  refusedMessage,
  reportedError,
  themeKindOf,
} from "../../../src/host/results/results-view-provider";
import {
  type HostToWebview,
  parseHostMessage,
  RESULTS_LIMITS,
  ResultsProtocolError,
} from "../../../src/results-protocol";
import { RUN_A } from "../../fixtures/results-sequences";
import {
  answerClipboard,
  ColorThemeKind,
  clipboardWrites,
  env,
  FakeWebviewView,
  setColorTheme,
  shownMessages,
  statusBarMessages,
  Uri,
  window,
} from "../../fakes/vscode";

const EXTENSION = "/ext";
const NONCE_1 = `${"0".repeat(31)}1`;
const NONCE_2 = `${"0".repeat(31)}2`;
const REPLAY: HostToWebview[] = [
  { v: 1, type: "runStarted", runId: RUN_A, statement: "select 1", startedAt: 1_760_000_000_000 },
  { v: 1, type: "pageStarted", runId: RUN_A },
];

/**
 * A provider over the fake window's theme, a session whose replay answers REPLAY and that records each call, a
 * command runner and a log that record, and nonces NONCE_1, NONCE_2.
 */
function setup() {
  const sessionCalls: string[] = [];
  const session: ResultsSession = {
    replay: () => {
      sessionCalls.push("replay");
      return REPLAY;
    },
    loadMore: async (runId) => {
      sessionCalls.push(`loadMore ${runId}`);
    },
  };
  const commandsRun: [string, ...unknown[]][] = [];
  let commandAnswer: () => Promise<unknown> = () => Promise.resolve(undefined);
  const lines: [string, string][] = [];
  const nonces = [NONCE_1, NONCE_2];
  const provider = new ResultsViewProvider({
    extensionUri: Uri.file(EXTENSION),
    window,
    clipboard: env.clipboard,
    commands: {
      executeCommand: <T>(command: string, ...rest: unknown[]): Thenable<T> => {
        commandsRun.push([command, ...rest]);
        return commandAnswer() as Thenable<T>;
      },
    },
    log: {
      warn: (message: string) => lines.push(["warn", message]),
      error: (message: string | Error) => lines.push(["error", String(message)]),
    },
    session,
    newNonce: () => nonces.shift() as string,
  });
  return {
    provider,
    sessionCalls,
    commandsRun,
    lines,
    answerCommand: (answer: () => Promise<unknown>) => {
      commandAnswer = answer;
    },
  };
}

/** A fresh view, resolved by the provider. */
function resolved(provider: ResultsViewProvider): FakeWebviewView {
  const view = new FakeWebviewView();
  provider.resolveWebviewView(view);
  return view;
}

/** What the view was posted, each held to the webview's guard. */
function postedTo(view: FakeWebviewView): HostToWebview[] {
  return view.posted.map((message) => parseHostMessage(message));
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("ResultsViewProvider: rendering", () => {
  it("sets minimal options and the document with a fresh nonce on each resolve (criterion 2)", () => {
    const { provider } = setup();
    const view = resolved(provider);
    const root = Uri.joinPath(Uri.file(EXTENSION), "dist", "webview");
    assert.deepEqual(view.webview.options, { enableScripts: true, enableForms: false, localResourceRoots: [root] });
    assert.deepEqual(Object.keys(view.webview.options).sort(), ["enableForms", "enableScripts", "localResourceRoots"]);
    const resource = "https://file+.vscode-resource.vscode-cdn.net/ext/dist/webview";
    assert.equal(
      view.webview.html,
      renderResultsHtml({
        cspSource: view.webview.cspSource,
        nonce: NONCE_1,
        scriptUri: `${resource}/results.js`,
        styleUri: `${resource}/results.css`,
      }),
    );
    assert.ok(
      view.webview.html.includes(
        `content="default-src 'none'; script-src 'nonce-${NONCE_1}'; style-src 'self' https://*.vscode-cdn.net 'nonce-${NONCE_1}' '${RADIX_SCROLL_AREA_STYLE_HASH}';"`,
      ),
    );

    view.dispose();
    const again = resolved(provider);
    assert.ok(again.webview.html.includes(`script-src 'nonce-${NONCE_2}'`));
  });

  it("asks the session for nothing until the view is ready", () => {
    const { provider, sessionCalls } = setup();
    const view = resolved(provider);
    assert.deepEqual(sessionCalls, []);
    assert.deepEqual(view.posted, []);
  });

  it("answers every ready with init and the replay, in order", () => {
    const { provider, sessionCalls } = setup();
    const view = resolved(provider);
    view.receive({ v: 1, type: "ready" });
    const answer = [{ v: 1, type: "init", theme: "dark" }, ...REPLAY];
    assert.deepEqual(postedTo(view), answer);
    view.receive({ v: 1, type: "ready" });
    assert.deepEqual(postedTo(view), [...answer, ...answer]);
    assert.deepEqual(sessionCalls, ["replay", "replay"]);
  });
});

describe("ResultsViewProvider: posting, revealing and describing", () => {
  const CLEAR: HostToWebview = { v: 1, type: "clear" };

  it("posts only to a resolved, visible, live view, whatever postMessage answers", () => {
    const { provider } = setup();
    provider.post(CLEAR);
    const view = resolved(provider);
    provider.post(CLEAR);
    assert.deepEqual(view.posted, [CLEAR]);
    view.visible = false;
    provider.post(CLEAR);
    assert.deepEqual(view.posted, [CLEAR]);
    view.visible = true;
    view.postAnswer = false;
    provider.post(CLEAR);
    provider.post(CLEAR);
    assert.deepEqual(view.posted, [CLEAR, CLEAR, CLEAR]);
    view.dispose();
    provider.post(CLEAR);
    assert.equal(view.posted.length, 3);
  });

  it("reveals through the focus command with no view, and through show(true) with one", async () => {
    const { provider, commandsRun } = setup();
    provider.reveal();
    assert.deepEqual(commandsRun, [["libredb.results.focus", { preserveFocus: true }]]);
    const view = resolved(provider);
    provider.reveal();
    assert.deepEqual(view.shows, [true]);
    assert.equal(commandsRun.length, 1);
    view.dispose();
    provider.reveal();
    assert.equal(commandsRun.length, 2);
    await settle();
  });

  it("logs a focus command that fails", async () => {
    const { provider, lines, answerCommand } = setup();
    answerCommand(() => Promise.reject(new Error("no such view")));
    provider.reveal();
    await settle();
    assert.deepEqual(lines, [["error", "Revealing the LibreDB Results view failed: no such view"]]);
  });

  it("applies a description given before the view resolves, and each one after at once", () => {
    const { provider } = setup();
    provider.describe("q.sql on shop");
    const view = resolved(provider);
    assert.equal(view.description, "q.sql on shop");
    provider.describe("a.sql on stock");
    assert.equal(view.description, "a.sql on stock");
    provider.describe(undefined);
    assert.equal(view.description, undefined);
    provider.describe("b.sql on shop");
    view.dispose();
    const again = resolved(provider);
    assert.equal(again.description, "b.sql on shop");
  });
});

describe("ResultsViewProvider: the theme (criterion 5's host half)", () => {
  it("maps each colour theme kind to the protocol's", () => {
    assert.equal(themeKindOf(ColorThemeKind.Light as number as vscode.ColorThemeKind), "light");
    assert.equal(themeKindOf(ColorThemeKind.Dark as number as vscode.ColorThemeKind), "dark");
    assert.equal(themeKindOf(ColorThemeKind.HighContrast as number as vscode.ColorThemeKind), "highContrast");
    assert.equal(themeKindOf(ColorThemeKind.HighContrastLight as number as vscode.ColorThemeKind), "highContrastLight");
  });

  it("sends the current kind in init, and theme on each change to a live, visible view only", () => {
    const { provider } = setup();
    setColorTheme(ColorThemeKind.Light);
    const view = resolved(provider);
    view.receive({ v: 1, type: "ready" });
    assert.deepEqual(postedTo(view)[0], { v: 1, type: "init", theme: "light" });
    const count = view.posted.length;

    setColorTheme(ColorThemeKind.HighContrast);
    assert.deepEqual(postedTo(view).slice(count), [{ v: 1, type: "theme", theme: "highContrast" }]);
    view.visible = false;
    setColorTheme(ColorThemeKind.Dark);
    assert.equal(view.posted.length, count + 1);

    view.visible = true;
    provider.dispose();
    setColorTheme(ColorThemeKind.HighContrastLight);
    assert.equal(view.posted.length, count + 1);
  });
});

describe("ResultsViewProvider: what the view sends", () => {
  /** A resolved view whose ready was answered, so only what a case's message causes is posted after it. */
  function ready() {
    const view = setup();
    const webview = resolved(view.provider);
    webview.receive({ v: 1, type: "ready" });
    const count = webview.posted.length;
    view.sessionCalls.length = 0;
    return { ...view, webview, after: () => webview.posted.slice(count) };
  }

  it("names the refused field in the warning sentence and the error in the error sentence", () => {
    assert.equal(
      refusedMessage(new ResultsProtocolError("runId", "missing")),
      "The LibreDB Results view sent a message the host refused: runId: missing.",
    );
    assert.equal(
      refusedMessage(new ResultsProtocolError("type", `unknown message type ${"y".repeat(500)}`)),
      `The LibreDB Results view sent a message the host refused: type: unknown message type ${"y".repeat(173)} (cut).`,
    );
    assert.equal(reportedError("boom"), "The LibreDB Results view reported an error: boom");
  });

  it("bounds the refusal line, so a message the view controls cannot write its text into the log", () => {
    const view = ready();
    view.webview.receive({ v: 1, type: "y".repeat(200_000) });
    view.webview.receive({ v: 1, type: "ready", ["k".repeat(200_000)]: 1 });
    assert.equal(view.lines.length, 2);
    for (const [level, line] of view.lines) {
      assert.equal(level, "warn");
      assert.ok(line.length <= 300, String(line.length));
      assert.ok(line.endsWith(" (cut)."), line.slice(-20));
    }
    assert.deepEqual(view.after(), []);
  });

  it("refuses each malformed message with one warning naming its field, and acts on none (criterion 6)", () => {
    const UUID_RUN = RUN_A;
    const cases: [unknown, string, string][] = [
      [{ v: 1, type: "export", runId: UUID_RUN }, "type", "unknown message type export"],
      [{ v: 2, type: "ready" }, "v", "expected 1"],
      [{ v: 1, type: "loadMore" }, "runId", "missing"],
      [{ v: 1, type: "loadMore", runId: "q1" }, "runId", "expected a UUID"],
      [
        { v: 1, type: "copy", requestId: 1, text: "x".repeat(RESULTS_LIMITS.copyTextChars + 1) },
        "text",
        `longer than ${RESULTS_LIMITS.copyTextChars} characters`,
      ],
      [{ v: 1, type: "notify", level: "info", message: "x".repeat(1_001) }, "message", "longer than 1000 characters"],
      [{ v: 1, type: "notify", level: "warning", message: "careful" }, "level", ""],
      [{ v: 1, type: "reportError", message: "x".repeat(10_001) }, "message", "longer than 10000 characters"],
      ...["statement", "connectionId", "queryId", "catalog", "limit", "offset", "path"].map(
        (key): [unknown, string, string] => [
          { v: 1, type: "loadMore", runId: UUID_RUN, [key]: key === "limit" || key === "offset" ? 2 : "x" },
          key,
          "not a field of loadMore",
        ],
      ),
    ];
    for (const [raw, field, reason] of cases) {
      const view = ready();
      view.webview.receive(raw);
      assert.equal(view.lines.length, 1, field);
      const [level, line] = view.lines[0];
      assert.equal(level, "warn");
      const prefix = `The LibreDB Results view sent a message the host refused: ${field}: `;
      assert.ok(line.startsWith(prefix), line);
      assert.ok(line.endsWith(reason === "" ? "." : `${reason}.`), line);
      assert.deepEqual(view.after(), [], field);
      assert.deepEqual(view.sessionCalls, [], field);
      assert.deepEqual(clipboardWrites, [], field);
      assert.deepEqual(statusBarMessages, [], field);
      assert.deepEqual(shownMessages, [], field);
    }
  });

  it("lets an error that is not a refusal out of the listener", () => {
    const view = ready();
    const raw = {
      get v(): number {
        throw new Error("a getter broke");
      },
    };
    assert.throws(() => view.webview.receive(raw), /a getter broke/);
    assert.deepEqual(view.lines, []);
  });

  it("hands loadMore's runId to the session, and nothing else", () => {
    const view = ready();
    view.webview.receive({ v: 1, type: "loadMore", runId: RUN_A });
    assert.deepEqual(view.sessionCalls, [`loadMore ${RUN_A}`]);
    assert.deepEqual(view.after(), []);
    assert.deepEqual(view.lines, []);
  });

  it("writes a copy to the clipboard and answers copied once the write settles (criterion 12's host half)", async () => {
    const view = ready();
    view.webview.receive({ v: 1, type: "copy", requestId: 7, text: "ada@example.com" });
    assert.deepEqual(clipboardWrites, ["ada@example.com"]);
    assert.deepEqual(view.after(), []);
    await settle();
    assert.deepEqual(view.after(), [{ v: 1, type: "copied", requestId: 7, ok: true }]);

    const longest = "x".repeat(RESULTS_LIMITS.copyTextChars);
    view.webview.receive({ v: 1, type: "copy", requestId: 8, text: longest });
    await settle();
    assert.equal(clipboardWrites[1], longest);
    assert.deepEqual(view.after().at(-1), { v: 1, type: "copied", requestId: 8, ok: true });
  });

  it("answers copied with ok false and logs the error when the clipboard write fails", async () => {
    const view = ready();
    answerClipboard(() => Promise.reject(new Error("no clipboard")));
    view.webview.receive({ v: 1, type: "copy", requestId: 9, text: "ada@example.com" });
    await settle();
    assert.deepEqual(view.after(), [{ v: 1, type: "copied", requestId: 9, ok: false }]);
    assert.deepEqual(view.lines, [["error", "The LibreDB Results view could not write the clipboard: no clipboard"]]);
  });

  it("shows an info notice in the status bar for three seconds and an error notice as a warning", () => {
    const view = ready();
    view.webview.receive({ v: 1, type: "notify", level: "info", message: "Copied to clipboard" });
    view.webview.receive({ v: 1, type: "notify", level: "error", message: "Could not copy to the clipboard." });
    assert.deepEqual(statusBarMessages, [["Copied to clipboard", 3000]]);
    assert.deepEqual(shownMessages, [{ level: "warning", message: "Could not copy to the clipboard.", items: [] }]);
    assert.deepEqual(view.after(), []);
  });

  it("shows a notice with its link syntax broken, so the view cannot put a clickable command link in a notification", () => {
    const view = ready();
    // VS Code's notification renders [label](command:...) as a link it opens with allowCommands (parseLinkedText).
    const LINK = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^)\s]+)(?: (["'])(.+?)(\3))?\)/i;
    const link = "[Retry](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22id%5Cn%22%7D)";
    view.webview.receive({ v: 1, type: "notify", level: "error", message: `Copy failed. ${link}` });
    view.webview.receive({ v: 1, type: "notify", level: "info", message: `Copied. ${link}` });
    assert.equal(shownMessages.length, 1);
    assert.equal(statusBarMessages.length, 1);
    for (const shown of [shownMessages[0].message, statusBarMessages[0][0]]) {
      assert.equal(LINK.test(shown), false, shown);
      assert.equal(/[[\]]/.test(shown), false, shown);
    }
    assert.ok(shownMessages[0].message.startsWith("Copy failed. Retry"), shownMessages[0].message);
    assert.deepEqual(view.after(), []);
  });

  it("logs a reported error at error level and posts nothing", () => {
    const view = ready();
    view.webview.receive({ v: 1, type: "reportError", message: "boom" });
    assert.deepEqual(view.lines, [["error", reportedError("boom")]]);
    assert.deepEqual(view.after(), []);
  });
});
