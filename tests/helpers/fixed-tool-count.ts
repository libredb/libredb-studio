/**
 * The matchers of `tests/unit/no-fixed-mcp-tool-count.test.ts`: where a fixed count of MCP tools, a literal list of
 * their names, a comma-joined engine list after "Runs on" or a neighbour-order pin may hide, and how each is read.
 *
 * The rule they hold is that the number and the list of MCP tools live in the registry alone, so a tool that starts
 * serving edits its own facet and its own doc section and nothing shared. Every hit is a line a flip would have to
 * edit by hand.
 *
 * Scope is two tiers. Files MCP owns are read on every line, because their count lines often say nothing else about
 * MCP; every other file is read only on a line that also names MCP, a metadata or statement tool, or the tool list.
 * A source file outside the MCP directory is read in its comments only, and MCP's own source in its comments and
 * strings, since a tool description is text an MCP client reads; tests and end-to-end specs are read whole, so a
 * title, an expected value and a pattern all count. Only
 * English count words are read: a translated README that states a count would pass, and no README states one.
 */
import { codeExtension, codeText, type TextLine } from "./comment-text";
import { matchesAny, namedLabels } from "./repo-text-scope";

export interface CountFinding {
  readonly path: string;
  /** One-based line of the file. */
  readonly line: number;
  readonly text: string;
}

/** The files read at all. */
export const inCountScope = (() => {
  const included = matchesAny(["**/README*.md", "docs/**/*.md", "src/**", "tests/**", "e2e/**", ".env.example"]);
  const excluded = matchesAny(["tests/fixtures/**"]);
  return (path: string): boolean => included(path) && !excluded(path);
})();

/** The files read on every line. */
export const isMcpOwned = matchesAny([
  "docs/MCP.md",
  "src/lib/mcp/**",
  "tests/**/mcp/**",
  "tests/helpers/mcp-*.ts",
  "tests/helpers/run-read-query.ts",
  "tests/unit/mcp-documentation.test.ts",
]);

const isTestFile = matchesAny(["tests/**", "e2e/**"]);
const readsMcpStrings = matchesAny(["src/lib/mcp/**"]);

/**
 * A line every other file is read on: it names MCP, one of its tools, or the tool list. "MCP" is read inside a longer
 * name too (`MCP_CLAIM`, `/\bMCP\b/`), since no English word holds those letters.
 */
export const MCP_LINE_MARKER =
  /mcp|list_connections|inspect_schema|metadata tools|\brun_[a-z]+_(?:read|query|command)\b|registerTool|listTools|tools\/list/i;

/** A count of two or more before "tools", as a word or a numeral. */
export const TOOL_COUNT =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty[a-z-]*|thirty[a-z-]*|\d{1,3})\s+(?:read-only\s+|MCP\s+|metadata\s+|statement\s+|shared\s+)*tools\b/i;

/** A literal length or call count on the tool list, in test code; zero is "none", which no flip changes. */
const FIXED_LENGTH = [/tools\)?\??\.?\)?\s*\.toHaveLength\(\s*[1-9]/, /registrations\.calls\)\.toBe\(\s*[1-9]/];

/** A test that pins a tool to its neighbour's position. */
const NEIGHBOUR_ORDER = /indexOf\(\s*"run_[a-z_]+"\s*\)\s*\+\s*1/;

/** A comma-joined engine list after the lead an engine sentence starts with. */
const RUNS_ON_LIST = /\b(?:It runs on|Runs on) [^$;.]*, /;

const TOOL_NAME = /^(?:list_connections|inspect_schema|run_[a-z_]+)$/;
const STATEMENT_TOOL_NAME = /^run_/;

/**
 * An array literal holding this many distinct tool names, this many of them statement tools, is a hand-written tool
 * list. A case table that calls the two metadata tools and one statement tool is a test of each, not a list a new
 * tool has to join.
 */
const TOOL_LIST_SIZE = 3;
const STATEMENT_TOOL_LIST_SIZE = 2;

/**
 * The fixed counts and literal lists in one file. `labels` are the engine display labels, which tell a "Runs on"
 * engine list from prose that happens to start the same way.
 */
export function countFindings(path: string, source: string, labels: readonly string[]): CountFinding[] {
  const lines = source.split("\n");
  const everyLine = isMcpOwned(path);
  const onMcpLine = (line: number): boolean => everyLine || MCP_LINE_MARKER.test(lines[line]);
  const found: CountFinding[] = [];
  const add = (line: number, text: string): void => {
    found.push({ path, line: line + 1, text: text.trim() });
  };

  const extension = codeExtension(path);
  const whole = lines.map((text, line) => ({ line, text }));
  let read: readonly TextLine[] = whole;
  if (extension !== null) {
    const code = codeText(source, path);
    if (!isTestFile(path)) read = readsMcpStrings(path) ? [...code.comments, ...code.strings] : code.comments;
    else {
      for (const array of code.arrays) {
        const names = [...new Set(array.strings.filter((text) => TOOL_NAME.test(text)))];
        const statementTools = names.filter((name) => STATEMENT_TOOL_NAME.test(name));
        if (names.length >= TOOL_LIST_SIZE && statementTools.length >= STATEMENT_TOOL_LIST_SIZE)
          add(array.line, `array literal of tool names: ${names.join(", ")}`);
      }
      for (const string of code.strings) {
        if (RUNS_ON_LIST.test(string.text) && namedLabels(string.text, labels).length >= 2)
          add(string.line, string.text);
      }
      lines.forEach((text, line) => {
        if (NEIGHBOUR_ORDER.test(text) || (onMcpLine(line) && FIXED_LENGTH.some((rule) => rule.test(text))))
          add(line, text);
      });
    }
  }
  for (const piece of read) {
    if (TOOL_COUNT.test(piece.text) && onMcpLine(piece.line)) add(piece.line, piece.text);
  }
  return found;
}
