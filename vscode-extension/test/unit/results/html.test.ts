import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RADIX_SCROLL_AREA_STYLE_HASH } from "../../../src/host/results/csp";
import { newNonce, renderResultsHtml } from "../../../src/host/results/html";
import { useDom } from "../../setup/dom";

const inputs = {
  cspSource: "https://file+.vscode-resource.vscode-cdn.net",
  nonce: "0123456789abcdef0123456789abcdef",
  scriptUri: "https://file+.vscode-resource.vscode-cdn.net/x/dist/webview/results.js",
  styleUri: "https://file+.vscode-resource.vscode-cdn.net/x/dist/webview/results.css",
};

describe("the results view's HTML", () => {
  it("writes criterion 2's CSP exactly", () => {
    const html = renderResultsHtml(inputs);
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];
    assert.equal(
      csp,
      `default-src 'none'; script-src 'nonce-${inputs.nonce}'; style-src ${inputs.cspSource} 'nonce-${inputs.nonce}' '${RADIX_SCROLL_AREA_STYLE_HASH}';`,
    );
  });

  it("is part 4's document with the inputs and the hash as its only interpolations", () => {
    assert.equal(
      renderResultsHtml(inputs),
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-0123456789abcdef0123456789abcdef'; style-src https://file+.vscode-resource.vscode-cdn.net 'nonce-0123456789abcdef0123456789abcdef' '${RADIX_SCROLL_AREA_STYLE_HASH}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://file+.vscode-resource.vscode-cdn.net/x/dist/webview/results.css">
  <title>LibreDB Results</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="0123456789abcdef0123456789abcdef" src="https://file+.vscode-resource.vscode-cdn.net/x/dist/webview/results.js"></script>
</body>
</html>
`,
    );
  });

  it("loads one script and one stylesheet and allows nothing else", () => {
    const html = renderResultsHtml(inputs);
    assert.equal(html.split("<script").length, 2);
    assert.ok(html.includes(`<script nonce="${inputs.nonce}" src="${inputs.scriptUri}"></script>`));
    assert.ok(html.includes(`<link rel="stylesheet" href="${inputs.styleUri}">`));
    assert.equal(html.includes("<style"), false);
    for (const directive of ["img-src", "font-src", "connect-src"]) assert.equal(html.includes(directive), false);
  });

  it("refuses an input that could leave its attribute or directive", () => {
    const unsafe: [keyof typeof inputs, string][] = [
      ["nonce", "0123456789ABCDEF0123456789ABCDEF"],
      ["nonce", "abc"],
      ["nonce", `${inputs.nonce}"`],
    ];
    for (const name of ["cspSource", "scriptUri", "styleUri"] as const) {
      for (const bad of ['"', "<", ">", "'", ";", " ", "\n", "\t"]) unsafe.push([name, `${inputs[name]}${bad}x`]);
    }
    for (const [name, value] of unsafe) {
      assert.throws(() => renderResultsHtml({ ...inputs, [name]: value }), {
        message: `renderResultsHtml was given an unsafe ${name}.`,
      });
    }
  });

  it("makes a fresh 32-hex-character nonce on every call", () => {
    const nonces = new Set(Array.from({ length: 100 }, newNonce));
    assert.equal(nonces.size, 100);
    for (const nonce of nonces) assert.match(nonce, /^[0-9a-f]{32}$/);
  });

  describe("the Radix ScrollArea style", () => {
    // Radix picks its layout effect once, at module load, by whether a document exists; a Radix module loaded here
    // without one would leave every later portal in the unit leg unmounted (results-app.test.tsx says more).
    useDom();

    it("hashes the one style the installed viewport renders without a nonce", async () => {
      const { Root, Viewport } = await import("@radix-ui/react-scroll-area");
      const markup = renderToStaticMarkup(createElement(Root, null, createElement(Viewport)));
      const styles = [...markup.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)];
      assert.equal(styles.length, 1);
      assert.equal(styles[0][0].includes("nonce"), false);
      const text = styles[0][1];
      assert.equal(RADIX_SCROLL_AREA_STYLE_HASH, `sha256-${createHash("sha256").update(text).digest("base64")}`);
    });
  });
});
