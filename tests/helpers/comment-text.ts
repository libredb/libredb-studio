/**
 * The comment and string text of a tracked file, line by line, for the repository-wide text guards
 * (`tests/unit/no-fixed-mcp-tool-count.test.ts` and `tests/unit/no-source-line-citations.test.ts`).
 *
 * Code files are parsed with the TypeScript parser in the syntax their extension names, so a regular expression, a
 * template literal or a JSX text never reads as a comment or a string: comments are the scanner's comment trivia
 * around every token, strings are the string and no-substitution template literals plus the literal parts of every
 * template expression, with each substitution removed. JSX text is neither, and a comment-shaped run inside it is not
 * a comment. A file in a `#` comment syntax (YAML, shell, Dockerfile, Makefile, an env file) gives its `#` comments,
 * and Go its `//` comment lines.
 *
 * Every piece is split into physical lines and each line keeps the zero-based line it sits on, so a guard can read
 * the whole source line around a hit.
 */
import ts from "typescript";

export interface TextLine {
  /** Zero-based line of the source file. */
  readonly line: number;
  readonly text: string;
}

export interface ArrayStrings {
  readonly line: number;
  readonly strings: readonly string[];
  /** The array is the case table of a `.each(...)` call, so each of its rows is a test of its own. */
  readonly caseTable: boolean;
}

export interface CodeText {
  readonly comments: readonly TextLine[];
  readonly strings: readonly TextLine[];
  /** Each array literal, by the line it opens on, with the text of every string literal inside it, nested ones included. */
  readonly arrays: readonly ArrayStrings[];
}

const SCRIPT_KINDS: Readonly<Record<string, ts.ScriptKind>> = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
};

/** The extension `codeText` parses, or `null` when the file is not code it reads. */
export function codeExtension(path: string): string | null {
  const match = /\.[a-z]+$/.exec(path);
  return match !== null && Object.hasOwn(SCRIPT_KINDS, match[0]) ? match[0] : null;
}

function splitLines(file: ts.SourceFile, start: number, text: string): TextLine[] {
  const first = file.getLineAndCharacterOfPosition(start).line;
  return text.split("\n").map((part, index) => ({ line: first + index, text: part }));
}

export function codeText(source: string, path: string): CodeText {
  const extension = codeExtension(path);
  if (extension === null) throw new Error(`${path} is not a file codeText parses`);
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[extension]);
  const comments: TextLine[] = [];
  const strings: TextLine[] = [];
  const arrays: { line: number; strings: string[]; caseTable: boolean }[] = [];
  const isCaseTable = (node: ts.ArrayLiteralExpression): boolean =>
    ts.isCallExpression(node.parent) &&
    node.parent.arguments.includes(node) &&
    ts.isPropertyAccessExpression(node.parent.expression) &&
    node.parent.expression.name.text === "each";
  const jsxText: ts.TextRange[] = [];
  const seen = new Set<number>();
  const ranges: ts.CommentRange[] = [];

  const collect = (found: readonly ts.CommentRange[] | undefined): void => {
    for (const range of found ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      ranges.push(range);
    }
  };

  const literalText = (node: ts.Node): string | null => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node))
      return node.head.text + node.templateSpans.map((span) => span.literal.text).join("");
    return null;
  };

  const visit = (node: ts.Node, openArrays: string[][]): void => {
    if (ts.isJsxText(node)) {
      jsxText.push(node);
      return;
    }
    collect(ts.getLeadingCommentRanges(source, node.pos));
    collect(ts.getTrailingCommentRanges(source, node.end));
    const text = literalText(node);
    if (text !== null) {
      strings.push(...splitLines(file, node.getStart(file), text));
      for (const array of openArrays) array.push(text);
    }
    let inner = openArrays;
    if (ts.isArrayLiteralExpression(node)) {
      const array: string[] = [];
      arrays.push({
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line,
        strings: array,
        caseTable: isCaseTable(node),
      });
      inner = [...openArrays, array];
    }
    for (const child of node.getChildren(file)) visit(child, inner);
  };
  visit(file, []);

  for (const range of ranges) {
    if (jsxText.some((jsx) => range.pos >= jsx.pos && range.pos < jsx.end)) continue;
    comments.push(...splitLines(file, range.pos, source.slice(range.pos, range.end)));
  }
  comments.sort((a, b) => a.line - b.line);
  return { comments, strings, arrays };
}

/**
 * The `#` comments of a file in a `#` comment syntax: a whole `#` line, or the text after a `#` that follows
 * whitespace (`key: value  # note`). A `#` inside a word or right after a value (`a#b`, a URL fragment) is not one.
 */
export function hashCommentLines(source: string): TextLine[] {
  const found: TextLine[] = [];
  source.split("\n").forEach((text, line) => {
    const match = /(?:^|\s)(#.*)$/.exec(text);
    if (match !== null) found.push({ line, text: match[1] });
  });
  return found;
}

/** The `//` comment lines of a Go file: lines that hold a comment and nothing else, so a URL in a string is not one. */
export function slashCommentLines(source: string): TextLine[] {
  const found: TextLine[] = [];
  source.split("\n").forEach((text, line) => {
    const match = /^\s*(\/\/.*)$/.exec(text);
    if (match !== null) found.push({ line, text: match[1] });
  });
  return found;
}
