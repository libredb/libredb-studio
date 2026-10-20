// The Results view's document (part 4 "The HTML, built by renderResultsHtml"): extension constants only, so nothing
// from a result, a setting or a workspace file enters it. Host code with no vscode import.
import { randomBytes } from "node:crypto";
import { RADIX_SCROLL_AREA_STYLE_HASH } from "./csp";

export interface ResultsHtmlInputs {
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
}

/** 16 random bytes from node:crypto as 32 hex characters. */
export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

const NONCE = /^[0-9a-f]{32}$/;
/** What could leave an attribute value or a CSP directive: a quote, a tag bracket, a directive separator, whitespace. */
const BREAKOUT = /["'<>;\s]/;

/** Part 4's document, byte for byte, with the four inputs and the hash as its only interpolations. */
export function renderResultsHtml(inputs: ResultsHtmlInputs): string {
  const { cspSource, nonce, scriptUri, styleUri } = inputs;
  const unsafe = !NONCE.test(nonce)
    ? "nonce"
    : (["cspSource", "scriptUri", "styleUri"] as const).find((name) => BREAKOUT.test(inputs[name]));
  if (unsafe) throw new Error(`renderResultsHtml was given an unsafe ${unsafe}.`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource} 'nonce-${nonce}' '${RADIX_SCROLL_AREA_STYLE_HASH}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>LibreDB Results</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>
`;
}
