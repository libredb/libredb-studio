/**
 * The Oxia Monaco language (SB2-4.6): registered once, every token role drawn as its token type, and the state the
 * tokens provider carries compared through the shared reader's own equality.
 */
import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { INITIAL_SHELL_LINE_STATE, type ShellLineState } from "@/lib/db/console/shell-words";
import { OXIA_LANGUAGE_ID, OxiaTokensState, registerOxiaLanguage } from "@/lib/editor/oxia-language";

// ---------------------------------------------------------------------------
// Mock Monaco: the harness of etcd-language.test.ts, kept local for the reason that file gives, so no mock module
// is shared between test files.
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

function oxiaProvider(): Monaco.languages.TokensProvider {
  const monaco = createMockMonaco();
  registerOxiaLanguage(monaco);
  return monaco._state.tokensProviders[0].provider;
}

/** One line's tokens as `type:text`, read from `state`, with the state it leaves. */
function draw(
  provider: Monaco.languages.TokensProvider,
  line: string,
  state: Monaco.languages.IState = provider.getInitialState(),
): { readonly tokens: string[]; readonly after: OxiaTokensState } {
  const { tokens, endState } = provider.tokenize(line, state);
  const drawn = tokens.map((token, index) => {
    const end = index + 1 < tokens.length ? tokens[index + 1].startIndex : line.length;
    return `${token.scopes}:${line.slice(token.startIndex, end)}`;
  });
  return { tokens: drawn, after: endState as OxiaTokensState };
}

describe("registerOxiaLanguage", () => {
  test("registers the language once, with a tokens provider and no Monarch grammar", () => {
    const monaco = createMockMonaco();
    registerOxiaLanguage(monaco);
    registerOxiaLanguage(monaco);
    expect(monaco._state.registered).toEqual([{ id: "oxia" }]);
    expect(OXIA_LANGUAGE_ID).toBe("oxia");
    expect(monaco._state.tokensProviders.map((entry) => entry.languageId)).toEqual(["oxia"]);
    expect(monaco._state.monarchProviders).toEqual([]);
  });

  test("leaves a language already registered under the id alone", () => {
    const monaco = createMockMonaco();
    monaco._state.registered.push({ id: "oxia" });
    registerOxiaLanguage(monaco);
    expect(monaco._state.tokensProviders).toEqual([]);
    expect(monaco._state.configurations).toEqual([]);
  });

  test("comments start with #, and single and double quotes close themselves", () => {
    const monaco = createMockMonaco();
    registerOxiaLanguage(monaco);
    expect(monaco._state.configurations).toEqual([
      {
        languageId: "oxia",
        configuration: {
          comments: { lineComment: "#" },
          autoClosingPairs: [
            { open: '"', close: '"' },
            { open: "'", close: "'" },
          ],
        },
      },
    ]);
  });
});

describe("the token type of each role", () => {
  test("lead as a comment, verb as a keyword, flag as a function, word, string, comment, whitespace, invalid", () => {
    const provider = oxiaProvider();
    expect(draw(provider, "$ oxia client get -t floor 'a b' $x # note").tokens).toEqual([
      "comment:$",
      ": ",
      "comment:oxia",
      ": ",
      "comment:client",
      ": ",
      "keyword:get",
      ": ",
      "function:-t",
      ": ",
      "identifier:floor",
      ": ",
      "string:'a b'",
      ": ",
      "invalid:$",
      "identifier:x",
      ": ",
      "comment:# note",
    ]);
  });

  test("starts from the shared reader's initial state", () => {
    const initial = oxiaProvider().getInitialState() as OxiaTokensState;
    expect(initial).toBeInstanceOf(OxiaTokensState);
    expect(initial.lex).toBe(INITIAL_SHELL_LINE_STATE);
  });

  test("a quote open at the end of a line carries into the next as a string", () => {
    const provider = oxiaProvider();
    const first = draw(provider, "get 'a");
    expect(first.after.lex).toEqual({
      section: "command",
      quote: "single",
      continued: false,
      inWord: true,
      wordsBefore: 1,
    });
    expect(draw(provider, "b'", first.after).tokens).toEqual(["string:b'"]);
  });
});

describe("OxiaTokensState", () => {
  const base: ShellLineState = { section: "command", quote: "double", continued: true, inWord: true, wordsBefore: 2 };

  test("equals another state of equal fields, through shellLineStatesEqual", () => {
    expect(new OxiaTokensState(base).equals(new OxiaTokensState({ ...base }))).toBe(true);
    expect(new OxiaTokensState(base).equals(new OxiaTokensState({ ...base, wordsBefore: 3 }))).toBe(false);
  });

  test("equals no other kind of state", () => {
    const other: Monaco.languages.IState = { clone: () => other, equals: () => true };
    expect(new OxiaTokensState(base).equals(other)).toBe(false);
  });

  test("a clone shares the reader's state, which is never written to", () => {
    const state = new OxiaTokensState(base);
    const clone = state.clone();
    expect(clone).not.toBe(state);
    expect(clone.lex).toBe(base);
    expect(clone.equals(state)).toBe(true);
  });
});
