// The browser leg's host stand-in: it serves dist/webview through renderResultsHtml at https://webview.test/ with
// page.route, so the leg starts no server (part 5 "Tests"), and fakes acquireVsCodeApi the way VS Code's host page
// provides it: one call per document, postMessage recorded, getState and setState over one saved value.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { newNonce, renderResultsHtml } from "../../src/host/results/html";
import type { HostToWebview, WebviewToHost } from "../../src/results-protocol";

const ORIGIN = "https://webview.test";
const DIST = join(__dirname, "..", "..", "dist", "webview");

/** The host page's own default, injected inside @layer vscode-default, which the bridge's unlayered body rule must beat. */
const HOST_DEFAULTS_CSS = "@layer vscode-default { body { padding: 0 20px; } }";

/**
 * The --vscode-* values the leg sets on <html>, as the host page sets them: the six the spec reads, and the rest of
 * the bridge's variables at distinct values it does not read.
 */
const VSCODE_VARIABLES: Record<string, string> = {
  "--vscode-panel-background": "rgb(10, 20, 30)",
  "--vscode-keybindingTable-headerBackground": "rgb(40, 50, 60)",
  "--vscode-editorWidget-background": "rgb(70, 80, 90)",
  "--vscode-foreground": "rgb(200, 201, 202)",
  "--vscode-focusBorder": "rgb(0, 120, 212)",
  "--vscode-contrastBorder": "rgb(255, 0, 255)",
  "--vscode-contrastActiveBorder": "rgb(255, 128, 0)",
  "--vscode-menu-background": "rgb(11, 21, 31)",
  "--vscode-menu-foreground": "rgb(12, 22, 32)",
  "--vscode-menu-selectionBackground": "rgb(13, 23, 33)",
  "--vscode-menu-selectionForeground": "rgb(14, 24, 34)",
  "--vscode-panel-border": "rgb(15, 25, 35)",
  "--vscode-editorWidget-border": "rgb(16, 26, 36)",
  "--vscode-input-border": "rgb(17, 27, 37)",
  "--vscode-toolbar-hoverBackground": "rgb(18, 28, 38)",
  "--vscode-list-hoverBackground": "rgb(19, 29, 39)",
  "--vscode-list-inactiveSelectionBackground": "rgb(20, 30, 40)",
  "--vscode-descriptionForeground": "rgb(21, 31, 41)",
  "--vscode-disabledForeground": "rgb(22, 32, 42)",
  "--vscode-textLink-foreground": "rgb(23, 33, 43)",
  "--vscode-button-background": "rgb(24, 34, 44)",
  "--vscode-button-hoverBackground": "rgb(25, 35, 45)",
  "--vscode-button-foreground": "rgb(26, 36, 46)",
  "--vscode-button-secondaryBackground": "rgb(27, 37, 47)",
  "--vscode-button-secondaryForeground": "rgb(28, 38, 48)",
  "--vscode-editorWarning-foreground": "rgb(29, 39, 49)",
  "--vscode-errorForeground": "rgb(30, 40, 50)",
  "--vscode-charts-green": "rgb(31, 41, 51)",
  "--vscode-charts-blue": "rgb(32, 42, 52)",
  "--vscode-charts-purple": "rgb(33, 43, 53)",
  "--vscode-charts-red": "rgb(34, 44, 54)",
  "--vscode-charts-orange": "rgb(35, 45, 55)",
  "--vscode-charts-yellow": "rgb(36, 46, 56)",
  "--vscode-font-family": "sans-serif",
  "--vscode-editor-font-family": "monospace",
};

export interface ResultsPage {
  page: Page;
  /** window.postMessage(message, "*") in the page, as the host's webview.postMessage arrives. */
  post(message: HostToWebview): Promise<void>;
  /** Every message the webview posted through the fake, in order. */
  posted(): Promise<WebviewToHost[]>;
  /** Each securitypolicyviolation event, as "<violatedDirective> <blockedURI>". */
  violations(): Promise<string[]>;
  /** What the webview last passed to setState, or undefined. */
  state(): Promise<unknown>;
  /** Reloads the document, keeping the saved state as VS Code does when it rebuilds a view, and waits for ready. */
  reload(): Promise<ResultsPage>;
}

/** Runs in the page before any of its scripts; the saved state lives in sessionStorage so a reload keeps it. */
function fakeHost(): void {
  const w = window as unknown as {
    __posted: unknown[];
    __violations: string[];
    __acquired: boolean;
    acquireVsCodeApi: () => unknown;
  };
  w.__posted = [];
  w.__violations = [];
  w.__acquired = false;
  document.addEventListener("securitypolicyviolation", (event) => {
    w.__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
  });
  w.acquireVsCodeApi = () => {
    if (w.__acquired) throw new Error("acquireVsCodeApi was called twice.");
    w.__acquired = true;
    return {
      postMessage: (message: unknown) => w.__posted.push(structuredClone(message)),
      getState: () => {
        const saved = sessionStorage.getItem("libredb-state");
        return saved === null ? undefined : JSON.parse(saved);
      },
      setState: (state: unknown) => sessionStorage.setItem("libredb-state", JSON.stringify(state)),
    };
  };
}

async function route(page: Page): Promise<void> {
  await page.route(`${ORIGIN}/**`, (request) => {
    const path = new URL(request.request().url()).pathname;
    if (path === "/index.html") {
      const body = renderResultsHtml({
        cspSource: ORIGIN,
        nonce: newNonce(),
        scriptUri: `${ORIGIN}/results.js`,
        styleUri: `${ORIGIN}/results.css`,
      });
      return request.fulfill({ contentType: "text/html", body });
    }
    if (path === "/results.js" || path === "/results.css") {
      const contentType = path.endsWith(".js") ? "text/javascript" : "text/css";
      return request.fulfill({ contentType, body: readFileSync(join(DIST, path.slice(1))) });
    }
    if (path === "/host-defaults.css") return request.fulfill({ contentType: "text/css", body: HOST_DEFAULTS_CSS });
    return request.fulfill({ status: 404, body: "" });
  });
}

/** Waits for ready, then sets the --vscode-* values through the CSSOM and links the host page's defaults. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    (window as unknown as { __posted: { type: string }[] }).__posted.some((m) => m.type === "ready"),
  );
  await page.evaluate(
    async ({ variables, href }) => {
      for (const [name, value] of Object.entries(variables)) document.documentElement.style.setProperty(name, value);
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      await new Promise<void>((resolve, reject) => {
        link.onload = () => resolve();
        link.onerror = () => reject(new Error(`${href} did not load.`));
        document.head.prepend(link);
      });
    },
    { variables: VSCODE_VARIABLES, href: `${ORIGIN}/host-defaults.css` },
  );
}

function results(page: Page): ResultsPage {
  return {
    page,
    post: (message) => page.evaluate((m) => window.postMessage(m, "*"), message),
    posted: () => page.evaluate(() => (window as unknown as { __posted: WebviewToHost[] }).__posted),
    violations: () => page.evaluate(() => (window as unknown as { __violations: string[] }).__violations),
    state: () =>
      page.evaluate(() => {
        const saved = sessionStorage.getItem("libredb-state");
        return saved === null ? undefined : JSON.parse(saved);
      }),
    reload: async () => {
      await page.reload();
      await settle(page);
      return results(page);
    },
  };
}

/** Serves dist/webview through renderResultsHtml at https://webview.test/, with a fake acquireVsCodeApi, and waits for ready. */
export async function openResultsView(page: Page, options: { width?: number } = {}): Promise<ResultsPage> {
  await page.setViewportSize({ width: options.width ?? 1280, height: 800 });
  if (!(page as Page & { __libredbRouted?: boolean }).__libredbRouted) {
    (page as Page & { __libredbRouted?: boolean }).__libredbRouted = true;
    await page.addInitScript(fakeHost);
    await route(page);
  }
  // A fresh document with no saved state, as a newly resolved view starts.
  await page.goto(`${ORIGIN}/index.html`);
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await settle(page);
  return results(page);
}
