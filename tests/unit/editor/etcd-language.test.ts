import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { INITIAL_LEX_STATE, splitWords, tokenizeLine, type Word } from "@/lib/db/providers/keyvalue/etcd/lexer";
import { ETCD_LANGUAGE_ID, EtcdTokensState, registerEtcdLanguage } from "@/lib/editor/etcd-language";
import { editorLanguageForTabType } from "@/lib/editor/tab-language";
import { type CorpusWord, GRAMMAR_CORPUS } from "../../fixtures/etcd/grammar-corpus";

// ---------------------------------------------------------------------------
// Mock Monaco: the harness of redis-language.test.ts, kept local for the reason that file gives, so no
// mock module is shared between test files, with the tokens-provider call this language makes in place
// of a Monarch grammar.
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

function etcdProvider(): Monaco.languages.TokensProvider {
  const monaco = createMockMonaco();
  registerEtcdLanguage(monaco);
  return monaco._state.tokensProviders[0]!.provider;
}

/** One physical line as the editor reads it: the state it starts in, its tokens, the state it leaves. */
interface EditorLine {
  readonly before: EtcdTokensState;
  readonly tokens: readonly Monaco.languages.IToken[];
  readonly after: EtcdTokensState;
}

/** A text read the way Monaco reads it: line by line, each from the state the line before left. */
function readAsTheEditorDoes(provider: Monaco.languages.TokensProvider, text: string): EditorLine[] {
  let state = provider.getInitialState() as EtcdTokensState;
  return text.split(/\r\n|\r|\n/).map((line) => {
    const { tokens, endState } = provider.tokenize(line, state);
    const row = { before: state, tokens, after: endState as EtcdTokensState };
    state = endState as EtcdTokensState;
    return row;
  });
}

/** The token types a word is drawn in: a bare word, a flag, and a quoted part. */
const WORD_TYPES: ReadonlySet<string> = new Set(["identifier", "function", "string"]);

/** A word's place, as the corpus and the parser both write it. */
interface Span {
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/**
 * The words the editor draws on the command line and on each txn request line: runs of word tokens that
 * touch, a run that reaches the end of a line continuing on the next while the state says a word runs on.
 * A compare line's parts are not words (the corpus keeps them apart), and a request line the parser refuses
 * holds none either, though the editor draws its other parts as it draws any word, so neither kind of line
 * starts one.
 */
function wordsDrawn(text: string, lines: readonly EditorLine[], refused: ReadonlySet<number>): Span[] {
  const physical = text.split(/\r\n|\r|\n/);
  const spans: Span[] = [];
  let open: { line: number; column: number; endLine: number; endColumn: number } | undefined;
  lines.forEach((row, index) => {
    const line = index + 1;
    const section = row.before.lex.section;
    const reads = (section === "command" || section === "success" || section === "failure") && !refused.has(line);
    row.tokens.forEach((token, at) => {
      const end = row.tokens[at + 1]?.startIndex ?? physical[index].length;
      if (!reads || !WORD_TYPES.has(token.scopes)) {
        if (open !== undefined) spans.push(open);
        open = undefined;
        return;
      }
      if (open === undefined) open = { line, column: token.startIndex, endLine: line, endColumn: end };
      else open = { ...open, endLine: line, endColumn: end };
    });
    if (open !== undefined && !row.after.lex.inWord) {
      spans.push(open);
      open = undefined;
    }
  });
  if (open !== undefined) spans.push(open);
  return spans;
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const corpusBytes = (word: CorpusWord): string => word.hex ?? hex(new TextEncoder().encode(word.text ?? ""));
const placeOf = (word: Span): Span => ({
  line: word.line,
  column: word.column,
  endLine: word.endLine,
  endColumn: word.endColumn,
});

/** The parser's words, the command line's then each request's, and the request lines it refuses. */
function parserWords(text: string): { readonly words: Word[]; readonly refused: ReadonlySet<number> } {
  const result = splitWords(text);
  if (!result.ok) throw new Error(`expected ${JSON.stringify(text)} to read, got: ${result.refusal.message}`);
  const { command, lines } = result.split;
  return {
    words: [...command, ...lines.flatMap((line) => line.words ?? [])],
    refused: new Set(lines.filter((line) => line.refusal !== undefined).map((line) => line.line)),
  };
}

describe("registerEtcdLanguage", () => {
  test("registers the etcd id once, with the lexer's tokens provider and no Monarch grammar", () => {
    const monaco = createMockMonaco();
    registerEtcdLanguage(monaco);
    registerEtcdLanguage(monaco);
    expect(monaco._state.registered.map((language) => language.id)).toEqual([ETCD_LANGUAGE_ID]);
    expect(monaco._state.tokensProviders.map((entry) => entry.languageId)).toEqual([ETCD_LANGUAGE_ID]);
    expect(monaco._state.monarchProviders).toEqual([]);
    expect(monaco._state.configurations).toHaveLength(1);
    expect(monaco._state.configurations[0]?.configuration.comments).toEqual({ lineComment: "#" });
  });

  test("the id is the one an etcd tab renders in", () => {
    expect(ETCD_LANGUAGE_ID).toBe("etcd");
    expect(editorLanguageForTabType("etcd")).toBe(ETCD_LANGUAGE_ID);
  });

  test("the initial state is the lexer's, and each line's tokens are the lexer's, by start and type", () => {
    const provider = etcdProvider();
    const initial = provider.getInitialState() as EtcdTokensState;
    expect(initial.lex).toBe(INITIAL_LEX_STATE);
    const line = "get /a --prefix 'b c' # note";
    const lexed = tokenizeLine(line, INITIAL_LEX_STATE);
    const drawn = provider.tokenize(line, initial);
    expect(drawn.tokens).toEqual([
      { startIndex: 0, scopes: "identifier" },
      { startIndex: 3, scopes: "" },
      { startIndex: 4, scopes: "identifier" },
      { startIndex: 6, scopes: "" },
      { startIndex: 7, scopes: "function" },
      { startIndex: 15, scopes: "" },
      { startIndex: 16, scopes: "string" },
      { startIndex: 21, scopes: "" },
      { startIndex: 22, scopes: "comment" },
    ]);
    expect(drawn.tokens.map((token) => token.startIndex)).toEqual(lexed.tokens.map((token) => token.start));
    expect((drawn.endState as EtcdTokensState).lex).toEqual(lexed.state);
  });

  test("a txn compare's punctuation is drawn as operators, and text the lexer refuses as invalid", () => {
    const provider = etcdProvider();
    const compares = provider.tokenize(
      'mod("k") > "0"',
      new EtcdTokensState({ ...INITIAL_LEX_STATE, section: "compares" }),
    );
    expect(compares.tokens.map((token) => token.scopes)).toEqual([
      "identifier",
      "operator",
      "string",
      "operator",
      "",
      "operator",
      "",
      "string",
    ]);
    expect(provider.tokenize("put k a;b", provider.getInitialState()).tokens.map((token) => token.scopes)).toContain(
      "invalid",
    );
  });
});

describe("EtcdTokensState", () => {
  test("a clone is equal, and holds the same lexer state", () => {
    const state = new EtcdTokensState(tokenizeLine("put k 'open", INITIAL_LEX_STATE).state);
    const clone = state.clone();
    expect(clone).not.toBe(state);
    expect(clone.lex).toBe(state.lex);
    expect(clone.equals(state)).toBe(true);
  });

  test("two states are equal when the lexer reads them as equal, and only then", () => {
    const open = tokenizeLine("put k 'open", INITIAL_LEX_STATE).state;
    // A state the lexer built again from the same line: another object, the same state.
    expect(
      new EtcdTokensState(open).equals(new EtcdTokensState(tokenizeLine("put k 'open", INITIAL_LEX_STATE).state)),
    ).toBe(true);
    expect(new EtcdTokensState(open).equals(new EtcdTokensState(INITIAL_LEX_STATE))).toBe(false);
    // Another language's state is never equal, whatever it holds.
    const foreign: Monaco.languages.IState = { clone: () => foreign, equals: () => true };
    expect(new EtcdTokensState(INITIAL_LEX_STATE).equals(foreign)).toBe(false);
  });
});

/**
 * The corpus the parser shares (tests/fixtures/etcd/grammar-corpus.ts): the editor's language, run as
 * Monaco runs it, draws the words the parser reads, in the section the parser reads each line in, and
 * those words hold the bytes the corpus measured (#1089, section 3.3; R11 ARCH-9).
 */
describe("the shared grammar corpus, read by the editor's language (spec 3.3, 10)", () => {
  const provider = etcdProvider();
  for (const entry of GRAMMAR_CORPUS) {
    describe(entry.name, () => {
      const lines = readAsTheEditorDoes(provider, entry.text);

      test("every line is read in the section the corpus names", () => {
        expect(lines.map((row) => row.before.lex.section)).toEqual([...entry.sections]);
      });

      if (entry.lexRefusal !== undefined) return;

      test("the words the editor draws are the parser's words, holding the corpus's bytes", () => {
        const { words, refused } = parserWords(entry.text);
        const drawn = wordsDrawn(entry.text, lines, refused);
        expect(drawn).toEqual(words.map(placeOf));
        expect(drawn).toEqual(entry.words.map(placeOf));
        expect(words.map((word) => hex(word.bytes))).toEqual(entry.words.map(corpusBytes));
      });
    });
  }

  test("the corpus holds words on several lines, a txn body among them, so the walk above is not vacuous", () => {
    expect(GRAMMAR_CORPUS.some((entry) => entry.words.some((word) => word.endLine > word.line))).toBe(true);
    expect(GRAMMAR_CORPUS.some((entry) => entry.sections.includes("success"))).toBe(true);
    // And request lines the parser refuses, whose parts the editor still draws.
    const read = GRAMMAR_CORPUS.filter((entry) => entry.lexRefusal === undefined);
    expect(read.filter((entry) => parserWords(entry.text).refused.size > 0).length).toBeGreaterThan(0);
  });
});
