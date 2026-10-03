import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import {
  CYPHER_INITIAL_STATE,
  CYPHER_KEYWORDS,
  type CypherToken,
  type CypherTokenKind,
  lexCypher,
  tokenizeCypherLine,
} from "@/lib/db/graph/cypher/lexer";
import { CYPHER_LANGUAGE_ID, CypherTokensState, registerCypherLanguage } from "@/lib/editor/cypher-language";
import { editorLanguageForTabType } from "@/lib/editor/tab-language";
import { CYPHER_CORPUS } from "../../fixtures/graph/cypher-corpus";

// ---------------------------------------------------------------------------
// Mock Monaco: the harness of etcd-language.test.ts, kept local for the reason that file gives, so no
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

function cypherProvider(): Monaco.languages.TokensProvider {
  const monaco = createMockMonaco();
  registerCypherLanguage(monaco);
  return monaco._state.tokensProviders[0]!.provider;
}

/** One significant piece as both readers place it: its offsets in the whole text and the token type it is drawn in. */
interface Piece {
  readonly start: number;
  readonly end: number;
  readonly scope: string;
}

const DELIMITERS: ReadonlySet<string> = new Set(["(", ")", "[", "]", "{", "}", ",", ".", ":", ";"]);

/** The token type a lexer token is drawn in, written out here so the test does not read the module's own table. */
function expectedScope(token: Pick<CypherToken, "kind" | "text" | "value">): string {
  const byKind: Record<Exclude<CypherTokenKind, "word" | "punct">, string> = {
    backtick: "identifier.quoted",
    string: "string",
    number: "number",
    parameter: "variable",
    comment: "comment",
    whitespace: "",
  };
  if (token.kind === "word") return CYPHER_KEYWORDS.has(token.value) ? "keyword" : "identifier";
  if (token.kind === "punct") return DELIMITERS.has(token.text) ? "delimiter" : "operator";
  return byKind[token.kind];
}

/**
 * The text as `lexCypher` reads it, as the editor must draw it: each significant token, cut at every
 * newline it holds, because the editor reads one physical line at a time. A piece that is empty after
 * the cut (an empty line inside a comment or a string) is drawn as nothing.
 */
function lexerPieces(text: string): Piece[] {
  const pieces: Piece[] = [];
  for (const token of lexCypher(text)) {
    if (token.kind === "whitespace") continue;
    const scope = expectedScope(token);
    let at = token.start;
    for (const part of token.text.split("\n")) {
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

describe("registerCypherLanguage", () => {
  test("registers the graph-cypher id once, with the lexer's tokens provider and no Monarch grammar", () => {
    const monaco = createMockMonaco();
    registerCypherLanguage(monaco);
    registerCypherLanguage(monaco);
    expect(monaco._state.registered.map((language) => language.id)).toEqual([CYPHER_LANGUAGE_ID]);
    expect(monaco._state.tokensProviders.map((entry) => entry.languageId)).toEqual([CYPHER_LANGUAGE_ID]);
    expect(monaco._state.monarchProviders).toEqual([]);
    expect(monaco._state.configurations).toHaveLength(1);
    const configuration = monaco._state.configurations[0]!.configuration;
    expect(configuration.comments).toEqual({ lineComment: "//", blockComment: ["/*", "*/"] });
    expect(configuration.brackets).toEqual([
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
    ]);
    expect(configuration.autoClosingPairs?.map((pair) => ("open" in pair ? pair.open : pair[0]))).toEqual([
      "(",
      "[",
      "{",
      "'",
      '"',
      "`",
    ]);
  });

  test("the id is the one a Cypher tab renders in, and not Monaco's own cypher id", () => {
    expect(CYPHER_LANGUAGE_ID).toBe("graph-cypher");
    expect(editorLanguageForTabType("cypher")).toBe(CYPHER_LANGUAGE_ID);
  });

  test("each token kind is drawn in its token type", () => {
    const provider = cypherProvider();
    const line = "MATCH (n:`L`)-[r]->(m) WHERE n.x = 'a' AND m.y > 1.5 RETURN $p, count // c";
    const drawn = provider.tokenize(line, provider.getInitialState());
    const scopes = drawn.tokens.map((token) => token.scopes).filter((scope) => scope !== "");
    expect(scopes).toEqual([
      "keyword",
      "delimiter",
      "identifier",
      "delimiter",
      "identifier.quoted",
      "delimiter",
      "operator",
      "delimiter",
      "identifier",
      "delimiter",
      "operator",
      "delimiter",
      "identifier",
      "delimiter",
      "keyword",
      "identifier",
      "delimiter",
      "identifier",
      "operator",
      "string",
      "keyword",
      "identifier",
      "delimiter",
      "identifier",
      "operator",
      "number",
      "keyword",
      "variable",
      "delimiter",
      "keyword",
      "comment",
    ]);
    const lexed = tokenizeCypherLine(line, CYPHER_INITIAL_STATE);
    expect(drawn.tokens.map((token) => token.startIndex)).toEqual(lexed.tokens.map((token) => token.start));
  });

  test("a keyword is matched without regard to case, as the lexer uppercases a word's value", () => {
    const provider = cypherProvider();
    const drawn = provider.tokenize("match (n) return n", provider.getInitialState());
    expect(drawn.tokens[0]).toEqual({ startIndex: 0, scopes: "keyword" });
  });

  test("a construct left open carries its state to the next line, and the next line resumes it", () => {
    const provider = cypherProvider();
    const first = provider.tokenize("RETURN 'open", provider.getInitialState());
    expect((first.endState as CypherTokensState).lex).toEqual({ in: "string", quote: "'" });
    const second = provider.tokenize("still' AS s", first.endState);
    expect(second.tokens[0]).toEqual({ startIndex: 0, scopes: "string" });
    expect((second.endState as CypherTokensState).lex).toEqual(CYPHER_INITIAL_STATE);
  });

  test("the corpus: every case is drawn with the lexer's token boundaries and kinds, one tokenisation (N9)", () => {
    const provider = cypherProvider();
    expect(CYPHER_CORPUS.length).toBeGreaterThan(0);
    for (const entry of CYPHER_CORPUS) {
      expect({ name: entry.name, pieces: editorPieces(provider, entry.text) }).toEqual({
        name: entry.name,
        pieces: lexerPieces(entry.text),
      });
    }
  });

  test("constructs spanning lines, an empty line inside them included, are drawn as the lexer reads them", () => {
    const provider = cypherProvider();
    const text = "MATCH /* a\n\nCREATE\nb */ (n:`x\ny`) RETURN '1\n\n2', n";
    expect(editorPieces(provider, text)).toEqual(lexerPieces(text));
    // The control: the multi-line comment's middle line is a comment, not the keyword it holds.
    expect(editorPieces(provider, text).find((piece) => text.slice(piece.start, piece.end) === "CREATE")?.scope).toBe(
      "comment",
    );
  });

  test("a backticked parameter spanning lines keeps the lexer's boundaries; its later lines are drawn as a backtick name", () => {
    // The line state carries an open backticked parameter as `backtick` (the lexer's docblock), so the
    // editor has no way to know the later line belongs to a parameter: the boundaries agree, the colour
    // of the continuation is the quoted identifier's.
    const provider = cypherProvider();
    const text = "RETURN $`p\nq`, 1";
    const bounds = (pieces: Piece[]) => pieces.map(({ start, end }) => [start, end]);
    expect(bounds(editorPieces(provider, text))).toEqual(bounds(lexerPieces(text)));
    expect(editorPieces(provider, text).map((piece) => piece.scope)).toEqual([
      "keyword",
      "variable",
      "identifier.quoted",
      "delimiter",
      "number",
    ]);
  });
});

describe("CypherTokensState", () => {
  test("a clone is equal and holds the same lexer state; states that differ are not equal", () => {
    const state = new CypherTokensState({ in: "string", quote: '"' });
    const clone = state.clone();
    expect(clone).not.toBe(state);
    expect(clone.lex).toBe(state.lex);
    expect(clone.equals(state)).toBe(true);
    expect(state.equals(new CypherTokensState({ in: "string", quote: "'" }))).toBe(false);
    expect(state.equals(new CypherTokensState({ in: "backtick" }))).toBe(false);
    expect(new CypherTokensState({ in: "backtick" }).equals(new CypherTokensState({ in: "backtick" }))).toBe(true);
    expect(state.equals({ clone: () => state, equals: () => true })).toBe(false);
  });
});
