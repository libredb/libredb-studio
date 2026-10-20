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
/**
 * What could leave an attribute value or a CSP directive: a quote, a tag bracket, a directive or policy separator, an
 * ampersand (the parser decodes a character reference such as &#59 inside the attribute), whitespace, a control character.
 */
const BREAKOUT_CHARACTERS = String.raw`"'<>;,&\s\p{Cc}`;
const BREAKOUT = new RegExp(`[${BREAKOUT_CHARACTERS}]`, "u");
/** One CSP source expression: a quoted keyword such as 'self', or a scheme or host source with no breakout character. */
const SOURCE_EXPRESSION = new RegExp(`^(?:'[a-z-]+'|[^${BREAKOUT_CHARACTERS}]+)$`, "u");

/**
 * The input that could break out of its attribute or directive, if any. webview.cspSource is source expressions
 * separated by single spaces (VS Code 1.120's is 'self' https://*.vscode-cdn.net, and a web extension's begins with
 * its location), so it alone may hold a space between sources and a quote around a keyword.
 */
function unsafeInput(inputs: ResultsHtmlInputs): keyof ResultsHtmlInputs | undefined {
  if (!NONCE.test(inputs.nonce)) return "nonce";
  if (!inputs.cspSource.split(" ").every((source) => SOURCE_EXPRESSION.test(source))) return "cspSource";
  return (["scriptUri", "styleUri"] as const).find((name) => BREAKOUT.test(inputs[name]));
}

/** Part 4's document, byte for byte, with the four inputs and the hash as its only interpolations. */
export function renderResultsHtml(inputs: ResultsHtmlInputs): string {
  const { cspSource, nonce, scriptUri, styleUri } = inputs;
  const unsafe = unsafeInput(inputs);
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
