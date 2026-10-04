import type { ConsoleDialectSpec } from "./dialect";
import type { ConsoleToken } from "./lexer";
import { consoleTokens, readConsoleBody } from "./parser";

/**
 * The console's Format (vector-family spec 3.5): the body re-indented from the lexer's tokens, two spaces a level,
 * with every other byte kept. The lines before the request line are kept as typed, the request line keeps its
 * method and target as typed, every literal keeps its bytes, and each comment after the request line keeps its
 * text on a line of its own. Lines are joined with LF, and the CR of a CRLF ending is dropped, so a text formats
 * to the same bytes whichever line ending it came with. A `JSON.parse` round trip would round an integer above 2^53, which is why the body is
 * never parsed into numbers here.
 *
 * A text the grammar cannot read is refused with the parser's own `ConsoleRefusal`, so Format never rewrites
 * a text the console would refuse to run; the route is not checked, because Format reads no route table.
 */

interface Piece {
  readonly kind: ConsoleToken["kind"];
  readonly text: string;
}

const SCALARS: ReadonlySet<ConsoleToken["kind"]> = new Set(["string", "number", "keyword"]);

/**
 * The index of the `]` closing the array opened at `open` when the array holds scalars and commas only, so it is
 * written on one line; undefined otherwise. The text was read first, so the closing bracket is there.
 */
function inlineArray(pieces: readonly Piece[], open: number): number | undefined {
  let at = open + 1;
  while (pieces[at].kind !== "punctuation" || pieces[at].text !== "]") {
    if (!SCALARS.has(pieces[at].kind) && pieces[at].text !== ",") return undefined;
    at++;
  }
  return at;
}

/** A line, or a comment that runs to its line's end, without the CR of a CRLF ending: Format writes LF alone. */
const withoutLineEndCr = (text: string): string => (text.endsWith("\r") ? text.slice(0, -1) : text);

export function formatConsole(spec: ConsoleDialectSpec, text: string): string {
  const read = consoleTokens(spec, text, true);
  readConsoleBody(spec, read);
  const { lines, tokens, request } = read;
  const out: string[] = lines.slice(0, request.line).map(withoutLineEndCr);
  out.push(lines[request.line].slice(0, request.bodyColumn));

  const pieces: Piece[] = [];
  for (let index = request.line; index < tokens.length; index++) {
    for (const token of tokens[index]) {
      if (index === request.line && token.start < request.bodyColumn) continue;
      pieces.push({ kind: token.kind, text: lines[index].slice(token.start, token.end) });
    }
  }

  let indent = 0;
  let current = "";
  const pad = () => "  ".repeat(indent);
  const flush = () => {
    if (current !== "") out.push(current);
    current = "";
  };
  for (let at = 0; at < pieces.length; at++) {
    const piece = pieces[at];
    if (piece.kind === "comment") {
      flush();
      out.push(`${pad()}${withoutLineEndCr(piece.text)}`);
      continue;
    }
    if (piece.kind === "punctuation" && (piece.text === "}" || piece.text === "]")) {
      flush();
      indent--;
      current = `${pad()}${piece.text}`;
      continue;
    }
    if (current === "") current = pad();
    if (piece.kind !== "punctuation") {
      current += piece.text;
      continue;
    }
    const next = pieces[at + 1];
    if (piece.text === "{" && next?.kind === "punctuation" && next.text === "}") {
      current += "{}";
      at++;
    } else if (piece.text === "[") {
      const close = inlineArray(pieces, at);
      if (close === undefined) {
        current += "[";
        indent++;
        flush();
      } else {
        current += `[${pieces
          .slice(at + 1, close)
          .filter((inner) => inner.kind !== "punctuation")
          .map((inner) => inner.text)
          .join(", ")}]`;
        at = close;
      }
    } else if (piece.text === "{") {
      current += "{";
      indent++;
      flush();
    } else if (piece.text === ",") {
      current += ",";
      flush();
    } else {
      current += ": ";
    }
  }
  flush();
  return out.join("\n");
}
