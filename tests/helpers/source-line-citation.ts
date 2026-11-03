/**
 * The matchers of `tests/unit/no-source-line-citations.test.ts`: where a tracked file may cite a source location by
 * its line number, and how a citation is told from a port, a clock time, a bind variable or an engine's own error text.
 *
 * A citation by line number goes stale the moment anything above the cited line changes, and a test that pins one
 * turns an unrelated change red; a citation names the enclosing symbol, a test title, a section heading or, for code
 * outside the repository, the upstream symbol and its pinned version.
 *
 * Read: the prose and fenced blocks of Markdown, the comments of code and of YAML, env, shell, Dockerfile, Makefile
 * and Go files, and, in code, the strings that name a tracked path with a line suffix past its first. A string naming
 * anything else, or line one of a file, is a computed report or a bind and is never read. A pasted stack frame inside a fence is quoted output.
 */
import { codeExtension, codeText, hashCommentLines, slashCommentLines, type TextLine } from "./comment-text";
import { matchesAny } from "./repo-text-scope";

export interface CitationFinding {
  readonly path: string;
  /** One-based line of the file. */
  readonly line: number;
  readonly text: string;
}

export type CitationSyntax = "markdown" | "code" | "hash" | "slash";

/**
 * Never read: changelogs (release history quotes what each release said), lockfiles, published static assets,
 * recorded fixtures (upstream evidence and corpus provenance cite pinned upstream files exactly as printed), and the
 * vendored protocol and grammar sources, which are upstream text.
 */
const EXCLUDED = matchesAny([
  "CHANGELOG.md",
  "**/CHANGELOG.md",
  "**/*.lock",
  "**/package-lock.json",
  "**/bun.lock",
  "public/**",
  "tests/fixtures/**",
  "**/*.proto",
  "**/*.g4",
]);

const HASH_SYNTAX = matchesAny([
  "**/*.yml",
  "**/*.yaml",
  ".env.example",
  "**/*.sh",
  "**/Dockerfile",
  "**/Dockerfile.*",
  "**/Makefile",
]);

/** How a tracked file is read, or `null` when it is out of scope. */
export function citationSyntax(path: string): CitationSyntax | null {
  if (EXCLUDED(path)) return null;
  if (path.endsWith(".md")) return "markdown";
  if (codeExtension(path) !== null) return "code";
  if (HASH_SYNTAX(path)) return "hash";
  if (path.endsWith(".go")) return "slash";
  return null;
}

/** A path with an extension, then a line or a range. */
export const PATH_LINE =
  /\b[\w@./-]+\.(?:tsx?|mts|mjs|cjs|jsx?|go|proto|g4|md|ya?ml|json|d\.ts)(?::|#L)\d+(?:[-:]\d+)?\b/g;

/**
 * A line suffix right after a backticked name or a Markdown link, read only on a line that names a file. A lone
 * backticked suffix needs two digits, since "`:1`" is a positional bind far more often than a line, and a suffix
 * after a backtick follows a closing one, never the opening backtick of that bind.
 */
const CONTINUATION = [/`:\d{2,}(?:-\d+)?`/, /(?:(?<=[^\s`])`|\]\([^)\s]*\)):\d+(?:-\d+)?\b/];
const FILE_NAME = /\.(?:tsx?|mjs|js)\b/;

/** "line N of `file`" and "`file` ... (line N)", N a number. */
const IMPLICIT = [
  /\b(?:near|around|at|see)?\s*lines?\s+\d+(?:\s*(?:-|,|and|to)\s*\d+)*\s+(?:of|in)\s+`[^`]+`/i,
  /`[^`]+\.\w+`[^.]{0,80}\((?:around |near )?lines?\s+\d+(?:\s*-\s*\d+)?\)/i,
];
/**
 * "at line N" names a location only when a tracked path follows it on the line ("at line N in factory.ts"); an
 * engine's "at line 1, column 5" never does, and neither does measured output that names its file first.
 */
const AT_LINE = /\b(?:at|near|around) lines? \d+\b(?!,? column)/;
/** "(line N)" in a code comment. */
const PAREN_LINE = /\(line \d+\)/;
/** A pasted stack frame. */
const STACK_FRAME = /^\s*at .*:\d+\)?$/;
/** A report position for a whole file is its first line, which a tool computes and no one cites. */
const WHOLE_FILE = /:1(?::\d+)?$/;
const PATH_TOKEN = /[\w@./-]+\.[A-Za-z]\w*/g;

/** Resolves a path as a tracked file: the file itself, or a tracked file it is the tail of after a `/`. */
export function trackedPathResolver(tracked: readonly string[]): (token: string) => boolean {
  const tails = new Set<string>();
  for (const file of tracked) {
    tails.add(file);
    for (let index = file.indexOf("/"); index !== -1; index = file.indexOf("/", index + 1))
      tails.add(file.slice(index + 1));
  }
  return (token) => tails.has(token.replace(/^(?:\.\.?\/)+/, ""));
}

function proseLines(source: string): TextLine[] {
  const read: TextLine[] = [];
  let fenced = false;
  source.split("\n").forEach((text, line) => {
    if (/^\s*(?:```|~~~)/.test(text)) fenced = !fenced;
    else if (fenced && STACK_FRAME.test(text)) return;
    read.push({ line, text });
  });
  return read;
}

/** The line-number citations in one file. `resolves` tells a tracked path from any other dotted name. */
export function citationFindings(
  path: string,
  source: string,
  resolves: (token: string) => boolean,
): CitationFinding[] {
  const syntax = citationSyntax(path);
  if (syntax === null) return [];
  const found: CitationFinding[] = [];
  const add = (piece: TextLine, text: string): void => {
    found.push({ path, line: piece.line + 1, text });
  };
  const namesTrackedPath = (text: string): boolean => (text.match(PATH_TOKEN) ?? []).some(resolves);

  const readProse = (piece: TextLine, inComment: boolean): void => {
    const paths = piece.text.match(PATH_LINE) ?? [];
    for (const match of paths) add(piece, match);
    if (paths.length > 0 || FILE_NAME.test(piece.text)) {
      for (const rule of CONTINUATION) {
        const match = rule.exec(piece.text);
        if (match !== null) add(piece, match[0]);
      }
    }
    for (const rule of IMPLICIT) {
      const match = rule.exec(piece.text);
      if (match !== null) add(piece, match[0].trim());
    }
    const atLine = AT_LINE.exec(piece.text);
    if (atLine !== null && namesTrackedPath(piece.text.slice(atLine.index + atLine[0].length))) add(piece, atLine[0]);
    const paren = inComment ? PAREN_LINE.exec(piece.text) : null;
    if (paren !== null) add(piece, paren[0]);
  };

  if (syntax === "markdown") {
    for (const piece of proseLines(source)) readProse(piece, false);
  } else if (syntax === "hash" || syntax === "slash") {
    for (const piece of syntax === "hash" ? hashCommentLines(source) : slashCommentLines(source))
      readProse(piece, true);
  } else {
    const code = codeText(source, path);
    for (const piece of code.comments) readProse(piece, true);
    for (const piece of code.strings) {
      for (const match of piece.text.match(PATH_LINE) ?? []) {
        const file = match.replace(/(?::|#L)\d+(?:[-:]\d+)?$/, "");
        if (file.includes("/") && resolves(file) && !WHOLE_FILE.test(match)) add(piece, match);
      }
    }
  }
  return found;
}
