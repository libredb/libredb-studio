/**
 * The kubectl Monaco language: registered once, every token role drawn as its token type, and the state the tokens
 * provider carries compared through the shared reader's own equality.
 */
import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { INITIAL_SHELL_LINE_STATE, type ShellLineState } from "@/lib/db/console/shell-words";
import { KUBECTL_LANGUAGE_ID, KubectlTokensState, registerKubectlLanguage } from "@/lib/editor/kubectl-language";

// ---------------------------------------------------------------------------
// Mock Monaco: the harness of oxia-language.test.ts, kept local for the reason that file gives, so no mock module
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

function kubectlProvider(): Monaco.languages.TokensProvider {
  const monaco = createMockMonaco();
  registerKubectlLanguage(monaco);
  return monaco._state.tokensProviders[0].provider;
}

/** One line's tokens as `type:text`, read from `state`, with the state it leaves. */
function draw(
  provider: Monaco.languages.TokensProvider,
  line: string,
  state: Monaco.languages.IState = provider.getInitialState(),
): { readonly tokens: string[]; readonly after: KubectlTokensState } {
  const { tokens, endState } = provider.tokenize(line, state);
  const drawn = tokens.map((token, index) => {
    const end = index + 1 < tokens.length ? tokens[index + 1].startIndex : line.length;
    return `${token.scopes}:${line.slice(token.startIndex, end)}`;
  });
  return { tokens: drawn, after: endState as KubectlTokensState };
}

describe("registerKubectlLanguage", () => {
  test("registers the language once, with a tokens provider and no Monarch grammar", () => {
    const monaco = createMockMonaco();
    registerKubectlLanguage(monaco);
    registerKubectlLanguage(monaco);
    expect(monaco._state.registered).toEqual([{ id: "kubectl" }]);
    expect(KUBECTL_LANGUAGE_ID).toBe("kubectl");
    expect(monaco._state.tokensProviders.map((entry) => entry.languageId)).toEqual(["kubectl"]);
    expect(monaco._state.monarchProviders).toEqual([]);
  });

  test("leaves a language already registered under the id alone", () => {
    const monaco = createMockMonaco();
    monaco._state.registered.push({ id: "kubectl" });
    registerKubectlLanguage(monaco);
    expect(monaco._state.tokensProviders).toEqual([]);
    expect(monaco._state.configurations).toEqual([]);
  });

  test("comments start with #, and single and double quotes close themselves", () => {
    const monaco = createMockMonaco();
    registerKubectlLanguage(monaco);
    expect(monaco._state.configurations).toEqual([
      {
        languageId: "kubectl",
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
  test("lead as a comment, command as a keyword, flag as a function, word, string, comment, invalid", () => {
    expect(draw(kubectlProvider(), "$ kubectl get pods -l 'app=web' $x # note").tokens).toEqual([
      "comment:$",
      ": ",
      "comment:kubectl",
      ": ",
      "keyword:get",
      ": ",
      "identifier:pods",
      ": ",
      "function:-l",
      ": ",
      "string:'app=web'",
      ": ",
      "invalid:$",
      "identifier:x",
      ": ",
      "comment:# note",
    ]);
  });

  test("starts from the shared reader's initial state", () => {
    const initial = kubectlProvider().getInitialState() as KubectlTokensState;
    expect(initial).toBeInstanceOf(KubectlTokensState);
    expect(initial.lex).toBe(INITIAL_SHELL_LINE_STATE);
  });

  test("a quote open at the end of a line carries into the next as a string", () => {
    const provider = kubectlProvider();
    const first = draw(provider, "get pods -l 'a");
    expect(first.after.lex).toEqual({
      section: "command",
      quote: "single",
      continued: false,
      inWord: true,
      wordsBefore: 3,
    });
    expect(draw(provider, "b'", first.after).tokens).toEqual(["string:b'"]);
  });
});

describe("KubectlTokensState", () => {
  const base: ShellLineState = { section: "command", quote: "double", continued: true, inWord: true, wordsBefore: 2 };

  test("equals another state of equal fields, through shellLineStatesEqual", () => {
    expect(new KubectlTokensState(base).equals(new KubectlTokensState({ ...base }))).toBe(true);
    expect(new KubectlTokensState(base).equals(new KubectlTokensState({ ...base, wordsBefore: 3 }))).toBe(false);
  });

  test("equals no other kind of state", () => {
    const other: Monaco.languages.IState = { clone: () => other, equals: () => true };
    expect(new KubectlTokensState(base).equals(other)).toBe(false);
  });

  test("a clone shares the reader's state, which is never written to", () => {
    const state = new KubectlTokensState(base);
    const clone = state.clone();
    expect(clone).not.toBe(state);
    expect(clone.lex).toBe(base);
    expect(clone.equals(state)).toBe(true);
  });
});
