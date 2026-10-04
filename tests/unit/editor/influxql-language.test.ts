import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import {
  INITIAL_INFLUXQL_LINE_STATE,
  type InfluxqlTokenKind,
  lexInfluxql,
} from "@/lib/db/providers/timeseries/influxdb/influxql-lexer";
import { INFLUXQL_LANGUAGE_ID, InfluxqlTokensState, registerInfluxqlLanguage } from "@/lib/editor/influxql-language";
import { editorLanguageForTabType } from "@/lib/editor/tab-language";

// ---------------------------------------------------------------------------
// Mock Monaco: the harness of cypher-language.test.ts, kept local for the reason that file gives, so no
// mock module is shared between test files.
// ---------------------------------------------------------------------------

interface MockMonacoState {
  registered: Monaco.languages.ILanguageExtensionPoint[];
  tokensProviders: Array<{ languageId: string; provider: Monaco.languages.TokensProvider }>;
  monarchProviders: string[];
  configurations: Array<{ languageId: string; configuration: Monaco.languages.LanguageConfiguration }>;
}

function createMockMonaco() {
  const state: MockMonacoState = { registered: [], tokensProviders: [], monarchProviders: [], configurations: [] };
  const mockMonaco = {
    languages: {
      getLanguages: () => state.registered,
      register: (language: Monaco.languages.ILanguageExtensionPoint) => {
        state.registered.push(language);
      },
      setTokensProvider: (languageId: string, provider: Monaco.languages.TokensProvider) => {
        state.tokensProviders.push({ languageId, provider });
        return { dispose: () => {} };
      },
      setMonarchTokensProvider: (languageId: string) => {
        state.monarchProviders.push(languageId);
        return { dispose: () => {} };
      },
      setLanguageConfiguration: (languageId: string, configuration: Monaco.languages.LanguageConfiguration) => {
        state.configurations.push({ languageId, configuration });
        return { dispose: () => {} };
      },
    },
    _state: state,
  };
  return mockMonaco as unknown as typeof Monaco & { _state: MockMonacoState };
}

function influxqlProvider(): Monaco.languages.TokensProvider {
  const monaco = createMockMonaco();
  registerInfluxqlLanguage(monaco);
  return monaco._state.tokensProviders[0]!.provider;
}

/** The token type each lexer kind is drawn in, written out here so the test does not read the module's own table. */
const EXPECTED_SCOPE: Readonly<Record<InfluxqlTokenKind, string>> = {
  whitespace: "",
  "line-comment": "comment",
  "block-comment": "comment",
  string: "string",
  "quoted-identifier": "identifier",
  identifier: "identifier",
  keyword: "keyword",
  number: "number",
  duration: "number",
  "bound-parameter": "invalid",
  regex: "regexp",
  operator: "operator",
  punctuation: "delimiter",
  semicolon: "delimiter",
  invalid: "invalid",
};

/** One piece as both readers place it: its offsets in the whole text and the token type it is drawn in. */
interface Piece {
  readonly start: number;
  readonly end: number;
  readonly scope: string;
}

/** The text as `lexInfluxql` reads it, each token cut at every newline it holds, as the editor reads one line at a time. */
function lexerPieces(text: string): Piece[] {
  const pieces: Piece[] = [];
  for (const token of lexInfluxql(text)) {
    const scope = EXPECTED_SCOPE[token.kind];
    if (scope === "") continue;
    let at = token.start;
    for (const part of text.slice(token.start, token.end).split("\n")) {
      if (part.length > 0) pieces.push({ start: at, end: at + part.length, scope });
      at += part.length + 1;
    }
  }
  return pieces;
}

/** The text as Monaco reads it through the registered provider: line by line, each from the state the line before left. */
function editorPieces(provider: Monaco.languages.TokensProvider, text: string): Piece[] {
  const pieces: Piece[] = [];
  let state = provider.getInitialState();
  let offset = 0;
  for (const line of text.split("\n")) {
    const { tokens, endState } = provider.tokenize(line, state);
    tokens.forEach((token, index) => {
      const end = tokens[index + 1]?.startIndex ?? line.length;
      if (token.scopes !== "")
        pieces.push({ start: offset + token.startIndex, end: offset + end, scope: token.scopes });
    });
    state = endState;
    offset += line.length + 1;
  }
  return pieces;
}

/** Texts whose every construct closes, so the editor's line-by-line reading and the whole-text reading agree. */
const MULTI_LINE_TEXTS: readonly string[] = [
  'SELECT mean("temp") FROM "home".."home"\nWHERE time > now() - 1h\nGROUP BY time(1m) fill(none)',
  "SELECT /* a comment\nacross ; DROP DATABASE x\nlines */ * FROM m",
  "SELECT * FROM m WHERE host =~\n/web.*/ AND x = 1",
  "SELECT a\n/ 2 FROM m",
  'SHOW MEASUREMENTS ON "db" WITH MEASUREMENT = /re/ -- trailing\nSHOW DATABASES',
  "SELECT * FROM m WHERE a = 'it\\'s' AND b::field / 2 > 1.5; SELECT $x FROM m",
];

describe("registerInfluxqlLanguage", () => {
  test("registers the influxql id once, with the lexer's tokens provider and no Monarch grammar", () => {
    const monaco = createMockMonaco();
    registerInfluxqlLanguage(monaco);
    registerInfluxqlLanguage(monaco);
    expect(monaco._state.registered.map((language) => language.id)).toEqual([INFLUXQL_LANGUAGE_ID]);
    expect(monaco._state.tokensProviders.map((entry) => entry.languageId)).toEqual([INFLUXQL_LANGUAGE_ID]);
    expect(monaco._state.monarchProviders).toEqual([]);
    expect(monaco._state.configurations).toHaveLength(1);
    const configuration = monaco._state.configurations[0]!.configuration;
    expect(configuration.comments).toEqual({ lineComment: "--", blockComment: ["/*", "*/"] });
    expect(configuration.brackets).toEqual([["(", ")"]]);
    expect(configuration.autoClosingPairs?.map((pair) => ("open" in pair ? pair.open : pair[0]))).toEqual([
      "(",
      "'",
      '"',
    ]);
  });

  test("the id is the one an influxql tab renders in", () => {
    expect(INFLUXQL_LANGUAGE_ID).toBe("influxql");
    expect(editorLanguageForTabType("influxql")).toBe(INFLUXQL_LANGUAGE_ID);
  });

  test("the id is not one the installed editor ships, so this tokens provider is the one in charge", () => {
    // The full three-place extraction is `tests/isolated/monaco-language-ids.test.ts`; this is the direct read.
    const root = dirname(createRequire(import.meta.url).resolve("monaco-editor/package.json"));
    const contribution = readFileSync(join(root, "min/vs/basic-languages/monaco.contribution.js"), "utf8");
    expect(contribution).toContain('id:"sql"');
    expect(contribution).not.toContain(`id:"${INFLUXQL_LANGUAGE_ID}"`);
    expect(readdirSync(join(root, "min/vs/language"))).not.toContain(INFLUXQL_LANGUAGE_ID);
  });

  test("each token kind is drawn in its token type, at the lexer's boundaries", () => {
    const provider = influxqlProvider();
    const line =
      "select \"t\", temp FROM db..m WHERE host =~ /web/ AND v > 1.5 AND time > now() - 1h AND x = 'a' AND y = $p; -- c";
    const drawn = provider.tokenize(line, provider.getInitialState());
    expect(drawn.tokens.map((token) => token.scopes).filter((scope) => scope !== "")).toEqual([
      "keyword",
      "identifier",
      "delimiter",
      "identifier",
      "keyword",
      "identifier",
      "delimiter",
      "delimiter",
      "identifier",
      "keyword",
      "identifier",
      "operator",
      "regexp",
      "keyword",
      "identifier",
      "operator",
      "number",
      "keyword",
      "identifier",
      "operator",
      "identifier",
      "delimiter",
      "delimiter",
      "operator",
      "number",
      "keyword",
      "identifier",
      "operator",
      "string",
      "keyword",
      "identifier",
      "operator",
      "invalid",
      "delimiter",
      "comment",
    ]);
    const lexed = lexInfluxql(line);
    expect(drawn.tokens.map((token) => token.startIndex)).toEqual(lexed.map((token) => token.start));
  });

  test("a character the lexer refuses is drawn invalid", () => {
    const provider = influxqlProvider();
    const drawn = provider.tokenize("SELECT # FROM m", provider.getInitialState());
    expect(drawn.tokens.find((token) => token.startIndex === 7)?.scopes).toBe("invalid");
  });

  test("a block comment across lines carries its state, and the next line resumes inside it", () => {
    const provider = influxqlProvider();
    const first = provider.tokenize("SELECT /* open", provider.getInitialState());
    expect((first.endState as InfluxqlTokensState).lex.inBlockComment).toBe(true);
    const second = provider.tokenize("DROP DATABASE x */ * FROM m", first.endState);
    expect(second.tokens[0]).toEqual({ startIndex: 0, scopes: "comment" });
    // The comment runs to its close, so the words it holds are never drawn as keywords.
    expect(second.tokens[1]?.startIndex).toBe("DROP DATABASE x */".length);
    expect((second.endState as InfluxqlTokensState).lex.inBlockComment).toBe(false);
  });

  test("a regex after an operator on an earlier line keeps its state; after an operand a slash divides", () => {
    const provider = influxqlProvider();
    const operator = provider.tokenize("SELECT * FROM m WHERE host =~", provider.getInitialState());
    expect((operator.endState as InfluxqlTokensState).lex.previous).toBe("other");
    expect(provider.tokenize("/web.*/", operator.endState).tokens[0]).toEqual({ startIndex: 0, scopes: "regexp" });

    const operand = provider.tokenize("SELECT a", provider.getInitialState());
    expect((operand.endState as InfluxqlTokensState).lex.previous).toBe("operand");
    expect(provider.tokenize("/ 2 FROM m", operand.endState).tokens[0]).toEqual({ startIndex: 0, scopes: "operator" });
  });

  test("texts across lines are drawn as the lexer reads the whole text: one tokenisation", () => {
    const provider = influxqlProvider();
    for (const text of MULTI_LINE_TEXTS) {
      expect({ text, pieces: editorPieces(provider, text) }).toEqual({ text, pieces: lexerPieces(text) });
    }
    // The control: the comment's middle line is a comment, not the statement it holds.
    const hidden = MULTI_LINE_TEXTS[1]!;
    expect(
      editorPieces(provider, hidden).find((piece) => hidden.slice(piece.start, piece.end).includes("DROP"))?.scope,
    ).toBe("comment");
  });
});

describe("InfluxqlTokensState", () => {
  test("a clone is equal and holds the same lexer state; states that differ are not equal", () => {
    const state = new InfluxqlTokensState({ inBlockComment: false, previous: "operand" });
    const clone = state.clone();
    expect(clone).not.toBe(state);
    expect(clone.lex).toBe(state.lex);
    expect(clone.equals(state)).toBe(true);
    expect(state.equals(new InfluxqlTokensState({ inBlockComment: false, previous: "operand" }))).toBe(true);
    expect(state.equals(new InfluxqlTokensState({ inBlockComment: true, previous: "operand" }))).toBe(false);
    expect(state.equals(new InfluxqlTokensState({ inBlockComment: false, previous: "other" }))).toBe(false);
    expect(state.equals({ clone: () => state, equals: () => true })).toBe(false);
  });

  test("the provider starts from the lexer's initial line state", () => {
    const provider = influxqlProvider();
    expect((provider.getInitialState() as InfluxqlTokensState).lex).toEqual(INITIAL_INFLUXQL_LINE_STATE);
  });
});
